import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  MAX_CANDIDATES_PER_TURN,
  MAX_EXTRACTION_EVENT_CHARS,
  MAX_EXTRACTION_EVENTS,
  MAX_EXTRACTION_TOTAL_CHARS,
  admitAutomaticCandidates,
  containsSensitiveContent,
  extractKnowledgeCandidates,
} from "../knowledge/extraction.js";
import type { ExtractionEventReference, KnowledgeDetectionResult, KnowledgeCandidateProposal } from "../knowledge/extraction.js";
import {
  extractLessonCandidatesWithActionReferences,
  MAX_LESSON_SESSION_ID_CHARS,
} from "../knowledge/lessons.js";
import type { LessonCandidateWithActionReference, LessonExtractionEventReference } from "../knowledge/lessons.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import type { KnowledgeScope } from "../knowledge/types.js";

export const MAX_QUEUED_EXTRACTION_JOBS = 8;
export const EXTRACTION_SHUTDOWN_TIMEOUT_MS = 500;
const MAX_USER_EVENTS_PER_TURN = MAX_EXTRACTION_EVENTS;
const MAX_USER_MESSAGE_BLOCKS = 32;
const MAX_OUTCOME_INVOCATIONS_PER_TURN = 8;

export type ExtractionEnqueueResult = "queued" | "duplicate" | "queue_full" | "closed";

type ExtractionJob = {
  owner: string;
  key: string;
  sessionGroup: string;
  sessionId: string;
  run(signal: AbortSignal): void | Promise<void>;
  onFailure(): void;
};

type TurnBuffer = {
  turn: number;
  scope: KnowledgeScope | null;
  events: ExtractionEventReference[];
  characters: number;
  activeStep?: number;
  pendingMessageSequences: number[];
  stepByMessageSequence: Map<number, number>;
  ambiguousMessageSequences: Set<number>;
  stepTrackingInvalid: boolean;
  invocations: InvocationRecord[];
  outcomeOverflowed: boolean;
};

type InvocationOutcome = Readonly<{
  outcome: "success" | "failure";
  sequence: number;
  timestamp: string;
}>;

type InvocationRecord = {
  kind: "native" | "ptc";
  turn: number;
  step: number;
  invocationId: string;
  toolName: string;
  rootCallId?: string;
  parentCallId?: string;
  outcome?: InvocationOutcome;
  invalid: boolean;
};

type ExtractionSnapshot = Readonly<{
  turn: number;
  events: readonly ExtractionEventReference[];
  stepByMessageSequence: ReadonlyMap<number, number>;
  ambiguousMessageSequences: ReadonlySet<number>;
  stepTrackingInvalid: boolean;
  invocations: readonly InvocationRecord[];
  outcomeOverflowed: boolean;
}>;

type QueueEntry<Job> = {
  job: Job;
  key: string;
  group: string;
};

type ActiveJob<Job> = {
  entry: QueueEntry<Job>;
  controller: AbortController;
  promise: Promise<void>;
};

type IdleWaiter<Job> = {
  predicate: ((job: Job) => boolean) | undefined;
  resolve: () => void;
};

export type ExtractionQueueOptions<Job> = {
  capacity?: number;
  keyOf: (job: Job) => string;
  groupOf?: (job: Job) => string;
  process: (job: Job, signal: AbortSignal) => void | Promise<void>;
  onError: (error: unknown, job?: Job) => void;
};

/** One active worker and a finite FIFO queue; overflow drops work immediately. */
export class BoundedExtractionQueue<Job> {
  private readonly capacity: number;
  private readonly options: ExtractionQueueOptions<Job>;
  private readonly queued: Array<QueueEntry<Job>> = [];
  private readonly keys = new Set<string>();
  private readonly idleWaiters: Array<IdleWaiter<Job>> = [];
  private active: ActiveJob<Job> | undefined;
  private scheduled = false;
  private closed = false;

  constructor(options: ExtractionQueueOptions<Job>) {
    this.options = options;
    this.capacity = options.capacity ?? MAX_QUEUED_EXTRACTION_JOBS;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError("Extraction queue capacity must be a positive integer.");
    }
  }

  get queuedCount(): number {
    return this.queued.length;
  }

  get activeCount(): number {
    return this.active === undefined ? 0 : 1;
  }

  enqueue(job: Job): ExtractionEnqueueResult {
    if (this.closed) {
      return "closed";
    }
    const key = this.options.keyOf(job);
    if (this.keys.has(key)) {
      return "duplicate";
    }
    if (this.queued.length >= this.capacity) {
      return "queue_full";
    }
    const entry = {
      job,
      key,
      group: this.options.groupOf?.(job) ?? key,
    };
    this.keys.add(key);
    this.queued.push(entry);
    this.schedule();
    return "queued";
  }

  cancelGroup(group: string): void {
    this.cancelWhere((_job, entry) => entry.group === group);
  }

  cancelWhere(predicate: (job: Job, entry: Readonly<QueueEntry<Job>>) => boolean): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      const entry = this.queued[index]!;
      if (predicate(entry.job, entry)) {
        this.queued.splice(index, 1);
        this.keys.delete(entry.key);
      }
    }
    if (this.active !== undefined && predicate(this.active.entry.job, this.active.entry)) {
      this.active.controller.abort();
    }
    this.resolveIdleIfNeeded();
  }

  async waitForActive(predicate: (job: Job) => boolean, timeoutMs: number): Promise<void> {
    const active = this.active;
    if (active === undefined || !predicate(active.entry.job)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      active.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  async close(
    timeoutMs = EXTRACTION_SHUTDOWN_TIMEOUT_MS,
    beforeWait: () => void = () => undefined,
  ): Promise<void> {
    this.closed = true;
    this.queued.length = 0;
    this.keys.clear();
    this.active?.controller.abort();
    beforeWait();

    const activePromise = this.active?.promise;
    if (activePromise === undefined) {
      this.resolveIdleIfNeeded();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      activePromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  async whenIdle(predicate?: (job: Job) => boolean): Promise<void> {
    if (!this.hasWork(predicate)) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.push({ predicate, resolve }));
  }

  private schedule(): void {
    if (this.scheduled || this.active !== undefined || this.closed) {
      return;
    }
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.closed || this.active !== undefined) {
      this.resolveIdleIfNeeded();
      return;
    }
    const entry = this.queued.shift();
    if (entry === undefined) {
      this.resolveIdleIfNeeded();
      return;
    }

    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.options.process(entry.job, controller.signal))
      .catch((error: unknown) => {
        try {
          this.options.onError(error, entry.job);
        } catch {
          // Reporting must not make the worker or agent event path fail.
        }
      })
      .finally(() => {
        this.keys.delete(entry.key);
        if (this.active?.entry === entry) {
          this.active = undefined;
        }
        this.schedule();
        this.resolveIdleIfNeeded();
      });
    this.active = { entry, controller, promise };
  }

  private resolveIdleIfNeeded(): void {
    for (let index = this.idleWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.idleWaiters[index]!;
      if (!this.hasWork(waiter.predicate)) {
        this.idleWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  private hasWork(predicate?: (job: Job) => boolean): boolean {
    return (this.active !== undefined && (predicate === undefined || predicate(this.active.entry.job))) ||
      this.queued.some(({ job }) => predicate === undefined || predicate(job));
  }
}

export type KnowledgeExtractionAdapterOptions = {
  getRepository: () => KnowledgeRepository | null;
  project?: string;
  onQueueFull?: () => void;
  onFailure?: () => void;
};

export type KnowledgeExtractionAdapter = {
  dispose(): Promise<void>;
  whenIdle(): Promise<void>;
};

let adapterSequence = 0;

// Shared by plugin instances so the process never runs concurrent extraction workers.
const processExtractionQueue = new BoundedExtractionQueue<ExtractionJob>({
  capacity: MAX_QUEUED_EXTRACTION_JOBS,
  keyOf: (job) => job.key,
  groupOf: (job) => job.sessionGroup,
  process: (job, signal) => job.run(signal),
  onError: (_error, job) => job?.onFailure(),
});

/** Bridges committed DSH events to the Harness-independent deterministic extractor. */
export function observeKnowledgeExtraction(
  context: Context,
  options: KnowledgeExtractionAdapterOptions,
): KnowledgeExtractionAdapter {
  const buffers = new WeakMap<Session, TurnBuffer>();
  const lastClosedTurn = new WeakMap<Session, number>();
  const owner = `adapter-${++adapterSequence}`;
  let disposed = false;

  const disposeEvent = context.on("session/event", (session, event) => {
    try {
      observeEvent(session, event);
    } catch {
      reportFailure();
    }
  });
  let disposeSession: () => void;
  try {
    disposeSession = context.on("session/disposed", (session) => {
      try {
        buffers.delete(session);
        lastClosedTurn.delete(session);
        const sessionId = String(session.id);
        processExtractionQueue.cancelWhere((job) => job.owner === owner && job.sessionId === sessionId);
      } catch {
        reportFailure();
      }
    });
  } catch (error: unknown) {
    disposeEvent();
    throw error;
  }

  function observeEvent(session: Session, event: SessionEvent): void {
    if (disposed) {
      return;
    }
    if (event.type === "turn/start") {
      buffers.set(session, {
        turn: event.data.turn,
        scope: scopeFor(session, options.project),
        events: [],
        characters: 0,
        pendingMessageSequences: [],
        stepByMessageSequence: new Map(),
        ambiguousMessageSequences: new Set(),
        stepTrackingInvalid: false,
        invocations: [],
        outcomeOverflowed: false,
      });
      return;
    }

    const buffer = buffers.get(session);
    if (buffer === undefined) {
      return;
    }

    if (event.type === "step/start") {
      observeStepStart(buffer, event.data.turn, event.data.step);
      return;
    }
    if (event.type === "step/end") {
      observeStepEnd(buffer, event.data.turn, event.data.step);
      return;
    }
    if (event.type === "tool/call") {
      observeNativeCall(buffer, event.data);
      return;
    }
    if (event.type === "tool/result") {
      observeNativeResult(buffer, event.data, event.seq, event.time);
      return;
    }
    if (event.type === "tool/ptc-dispatch-start") {
      observePtcStart(buffer, event.data);
      return;
    }
    if (event.type === "tool/ptc-dispatch") {
      observePtcResult(buffer, event.data, event.seq, event.time);
      return;
    }

    if (event.type === "user/message") {
      if (event.data.source.kind !== "user" || buffer.events.length >= MAX_USER_EVENTS_PER_TURN) {
        return;
      }
      const text = textFromUserMessage(event.data.content);
      if (
        text.length === 0 ||
        text.length > MAX_EXTRACTION_EVENT_CHARS ||
        buffer.characters + text.length > MAX_EXTRACTION_TOTAL_CHARS ||
        containsSensitiveContent(text)
      ) {
        return;
      }
      const timestamp = new Date(event.time);
      if (!Number.isFinite(timestamp.getTime())) {
        return;
      }
      buffer.events.push({
        sequence: event.seq,
        timestamp: timestamp.toISOString(),
        kind: "user_message",
        author: "human",
        text,
      });
      observeUserMessageStep(buffer, event.seq);
      buffer.characters += text.length;
      return;
    }

    if (event.type !== "turn/end" || event.data.turn !== buffer.turn) {
      return;
    }

    buffers.delete(session);
    const lastTurn = lastClosedTurn.get(session);
    if (lastTurn !== undefined && buffer.turn <= lastTurn) {
      return;
    }
    // DSH turn numbers are monotonic; retaining only the latest avoids per-session growth.
    lastClosedTurn.set(session, buffer.turn);
    if (buffer.scope === null || buffer.events.length === 0) {
      return;
    }
    const sessionId = String(session.id);
    const scope = buffer.scope;
    const snapshot: ExtractionSnapshot = {
      turn: buffer.turn,
      events: buffer.events,
      stepByMessageSequence: new Map(buffer.stepByMessageSequence),
      ambiguousMessageSequences: new Set(buffer.ambiguousMessageSequences),
      stepTrackingInvalid: buffer.stepTrackingInvalid,
      invocations: buffer.outcomeOverflowed ? [] : buffer.invocations.map((record) => ({ ...record })),
      outcomeOverflowed: buffer.outcomeOverflowed,
    };
    const job: ExtractionJob = {
      owner,
      key: JSON.stringify([owner, sessionId, buffer.turn]),
      sessionGroup: JSON.stringify([owner, sessionId]),
      sessionId,
      run: (signal) => {
        if (signal.aborted) {
          return;
        }
        const repository = options.getRepository();
        if (repository === null) {
          return;
        }
        persistTurnCandidates(repository, {
          sessionId,
          scope,
          snapshot,
        });
      },
      onFailure: () => options.onFailure?.(),
    };
    const result = processExtractionQueue.enqueue(job);
    if (result === "queue_full") {
      try {
        options.onQueueFull?.();
      } catch {
        reportFailure();
      }
    }
  }

  function reportFailure(): void {
    try {
      options.onFailure?.();
    } catch {
      // Extraction error reporting must not affect the Harness event path.
    }
  }

  return {
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        disposeEvent();
      } catch {
        reportFailure();
      }
      try {
        disposeSession();
      } catch {
        reportFailure();
      }
      processExtractionQueue.cancelWhere((job) => job.owner === owner);
      await processExtractionQueue.waitForActive(
        (job) => job.owner === owner,
        EXTRACTION_SHUTDOWN_TIMEOUT_MS,
      );
    },
    whenIdle: () => processExtractionQueue.whenIdle((job) => job.owner === owner),
  };
}

function observeStepStart(buffer: TurnBuffer, turn: number, step: number): void {
  if (turn !== buffer.turn || !Number.isSafeInteger(step) || step < 0) {
    buffer.stepTrackingInvalid = true;
    return;
  }
  if (buffer.activeStep !== undefined) {
    buffer.stepTrackingInvalid = true;
    buffer.activeStep = undefined;
    buffer.pendingMessageSequences = [];
    return;
  }
  buffer.activeStep = step;
  for (const sequence of buffer.pendingMessageSequences) {
    if (buffer.ambiguousMessageSequences.has(sequence)) continue;
    if (buffer.stepByMessageSequence.has(sequence)) {
      buffer.ambiguousMessageSequences.add(sequence);
      buffer.stepByMessageSequence.delete(sequence);
      continue;
    }
    buffer.stepByMessageSequence.set(sequence, step);
  }
  buffer.pendingMessageSequences = [];
}

function observeStepEnd(buffer: TurnBuffer, turn: number, step: number): void {
  if (turn !== buffer.turn || buffer.activeStep !== step) {
    buffer.stepTrackingInvalid = true;
    buffer.activeStep = undefined;
    buffer.pendingMessageSequences = [];
    return;
  }
  buffer.activeStep = undefined;
}

function observeUserMessageStep(buffer: TurnBuffer, sequence: number): void {
  if (buffer.stepTrackingInvalid) return;
  if (buffer.stepByMessageSequence.has(sequence) || buffer.pendingMessageSequences.includes(sequence)) {
    buffer.ambiguousMessageSequences.add(sequence);
    buffer.stepByMessageSequence.delete(sequence);
    buffer.pendingMessageSequences = buffer.pendingMessageSequences.filter((value) => value !== sequence);
    return;
  }
  if (buffer.activeStep === undefined) {
    buffer.pendingMessageSequences.push(sequence);
  } else {
    buffer.stepByMessageSequence.set(sequence, buffer.activeStep);
  }
}

function observeNativeCall(
  buffer: TurnBuffer,
  data: { turn: number; step: number; callId: string; name: string },
): void {
  if (
    data.turn !== buffer.turn || !Number.isSafeInteger(data.step) || data.step < 0 ||
    typeof data.callId !== "string" || data.callId.length === 0 ||
    typeof data.name !== "string" || data.name.length === 0
  ) {
    return;
  }
  const duplicate = buffer.invocations.filter((record) =>
    record.kind === "native" && record.turn === data.turn && record.step === data.step &&
    record.invocationId === data.callId);
  const record: InvocationRecord = {
    kind: "native",
    turn: data.turn,
    step: data.step,
    invocationId: data.callId,
    toolName: data.name,
    invalid: duplicate.length > 0,
  };
  for (const previous of duplicate) previous.invalid = true;
  retainInvocation(buffer, record);
}

function observeNativeResult(
  buffer: TurnBuffer,
  data: { turn: number; step: number; message: { toolCallId: string; isError?: boolean }; error?: { code: string } },
  sequence: number,
  time: number,
): void {
  if (
    data.turn !== buffer.turn || !Number.isSafeInteger(data.step) || data.step < 0 ||
    typeof data.message?.toolCallId !== "string" || data.message.toolCallId.length === 0
  ) {
    return;
  }
  const matches = buffer.invocations.filter((record) =>
    record.kind === "native" && record.turn === data.turn && record.step === data.step &&
    record.invocationId === data.message.toolCallId);
  if (matches.length !== 1) {
    for (const record of matches) record.invalid = true;
    return;
  }
  const record = matches[0]!;
  if (record.invalid || record.outcome !== undefined) {
    record.invalid = true;
    return;
  }
  const timestamp = outcomeTimestamp(time);
  const errorCode = data.error?.code;
  if (typeof data.message.isError !== "boolean" || timestamp === null || !usableInvocationOutcome(data.message.isError, errorCode)) {
    record.invalid = true;
    return;
  }
  record.outcome = {
    outcome: data.message.isError ? "failure" : "success",
    sequence,
    timestamp,
  };
}

function observePtcStart(
  buffer: TurnBuffer,
  data: { rootCallId: string; parentCallId: string; subCallId: string; name: string },
): void {
  if (
    typeof data.rootCallId !== "string" || data.rootCallId.length === 0 ||
    typeof data.parentCallId !== "string" || data.parentCallId.length === 0 ||
    typeof data.subCallId !== "string" || data.subCallId.length === 0 ||
    typeof data.name !== "string" || data.name.length === 0
  ) {
    return;
  }
  // PTC events omit turn/step; the verified root call identity supplies both.
  const parents = buffer.invocations.filter((record) =>
    record.kind === "native" && record.turn === buffer.turn && record.invocationId === data.rootCallId);
  if (parents.length !== 1 || parents[0]!.invalid) return;
  const parent = parents[0]!;
  const duplicate = buffer.invocations.filter((record) =>
    record.kind === "ptc" && record.invocationId === data.subCallId);
  const record: InvocationRecord = {
    kind: "ptc",
    turn: parent.turn,
    step: parent.step,
    invocationId: data.subCallId,
    toolName: data.name,
    rootCallId: data.rootCallId,
    parentCallId: data.parentCallId,
    invalid: duplicate.length > 0,
  };
  for (const previous of duplicate) previous.invalid = true;
  retainInvocation(buffer, record);
}

function observePtcResult(
  buffer: TurnBuffer,
  data: {
    rootCallId: string;
    parentCallId: string;
    subCallId: string;
    name: string;
    isError: boolean;
    error?: { code: string };
  },
  sequence: number,
  time: number,
): void {
  if (typeof data.subCallId !== "string" || data.subCallId.length === 0) return;
  const matches = buffer.invocations.filter((record) =>
    record.kind === "ptc" && record.invocationId === data.subCallId);
  if (matches.length !== 1) {
    for (const record of matches) record.invalid = true;
    return;
  }
  const record = matches[0]!;
  if (
    record.invalid || record.outcome !== undefined ||
    record.rootCallId !== data.rootCallId || record.parentCallId !== data.parentCallId ||
    record.toolName !== data.name
  ) {
    record.invalid = true;
    return;
  }
  const timestamp = outcomeTimestamp(time);
  const errorCode = data.error?.code;
  if (typeof data.isError !== "boolean" || timestamp === null || !usableInvocationOutcome(data.isError, errorCode)) {
    record.invalid = true;
    return;
  }
  record.outcome = {
    outcome: data.isError ? "failure" : "success",
    sequence,
    timestamp,
  };
}

function retainInvocation(buffer: TurnBuffer, record: InvocationRecord): void {
  if (buffer.outcomeOverflowed) return;
  if (buffer.invocations.length >= MAX_OUTCOME_INVOCATIONS_PER_TURN) {
    buffer.outcomeOverflowed = true;
    buffer.invocations = [];
    return;
  }
  buffer.invocations.push(record);
}

function outcomeTimestamp(time: number): string | null {
  if (!Number.isFinite(time)) return null;
  const timestamp = new Date(time);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function usableInvocationOutcome(isError: boolean, errorCode: string | undefined): boolean {
  // An unclassified failure cannot prove the call was a registered tool invocation.
  return errorCode !== "UNKNOWN_TOOL" && (!isError || (errorCode !== undefined && errorCode.length > 0));
}

function persistTurnCandidates(
  repository: KnowledgeRepository,
  input: { sessionId: string; scope: KnowledgeScope; snapshot: ExtractionSnapshot },
): void {
  const m4 = extractKnowledgeCandidates({
    sessionId: input.sessionId,
    scope: input.scope,
    events: input.snapshot.events,
  });
  const m61 = input.sessionId.length <= MAX_LESSON_SESSION_ID_CHARS
    ? extractLessonCandidatesWithActionReferences({
        sessionId: input.sessionId,
        scope: input.scope,
        events: input.snapshot.events as readonly LessonExtractionEventReference[],
      })
    : { candidates: [], sensitiveCount: 0 };
  const remaining = Math.max(0, MAX_CANDIDATES_PER_TURN - m4.candidates.length);
  const lessons = m61.candidates.slice(0, remaining).map((candidate) =>
    attachOutcomeEvidence(candidate, input.sessionId, input.snapshot));
  const detection: KnowledgeDetectionResult = {
    candidates: [...m4.candidates, ...lessons],
    sensitiveCount: m4.sensitiveCount + m61.sensitiveCount,
  };
  admitAutomaticCandidates(repository, input.scope, detection);
}

function attachOutcomeEvidence(
  candidate: LessonCandidateWithActionReference,
  sessionId: string,
  snapshot: ExtractionSnapshot,
): KnowledgeCandidateProposal {
  const step = snapshot.stepTrackingInvalid || snapshot.ambiguousMessageSequences.has(candidate.sequence)
    ? undefined
    : snapshot.stepByMessageSequence.get(candidate.sequence);
  if (candidate.actionReference === undefined || step === undefined || snapshot.outcomeOverflowed) {
    return candidate.proposal;
  }
  const matches = snapshot.invocations.filter((record) =>
    record.turn === snapshot.turn && record.step === step && record.toolName === candidate.actionReference);
  if (matches.length !== 1) return candidate.proposal;
  const invocation = matches[0]!;
  if (invocation.invalid || invocation.outcome === undefined) return candidate.proposal;
  return {
    ...candidate.proposal,
    evidence: [...candidate.proposal.evidence, {
      type: "session",
      source: sessionId,
      locator: `seq=${invocation.outcome.sequence}`,
      timestamp: invocation.outcome.timestamp,
    }],
  };
}

function scopeFor(session: Session, project: string | undefined): KnowledgeScope | null {
  const workspace = session.header.cwd;
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    return null;
  }
  return {
    workspace,
    ...(project === undefined ? {} : { project }),
  };
}

function textFromUserMessage(content: readonly { type: string; text?: string }[]): string {
  if (content.length > MAX_USER_MESSAGE_BLOCKS) {
    return "x".repeat(MAX_EXTRACTION_EVENT_CHARS + 1);
  }
  let text = "";
  for (const block of content) {
    if (block.type !== "text" || text.length > MAX_EXTRACTION_EVENT_CHARS) {
      continue;
    }
    const remaining = MAX_EXTRACTION_EVENT_CHARS + 1 - text.length;
    text += `${(block.text ?? "").slice(0, remaining)} `;
  }
  return text.trim();
}
