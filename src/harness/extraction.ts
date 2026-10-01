import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  MAX_EXTRACTION_EVENT_CHARS,
  MAX_EXTRACTION_EVENTS,
  MAX_EXTRACTION_TOTAL_CHARS,
  containsSensitiveContent,
  persistKnowledgeCandidates,
} from "../knowledge/extraction.js";
import type { ExtractionEventReference } from "../knowledge/extraction.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import type { KnowledgeScope } from "../knowledge/types.js";

export const MAX_QUEUED_EXTRACTION_JOBS = 8;
export const EXTRACTION_SHUTDOWN_TIMEOUT_MS = 500;
const MAX_USER_EVENTS_PER_TURN = MAX_EXTRACTION_EVENTS;
const MAX_USER_MESSAGE_BLOCKS = 32;

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
};

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
      });
      return;
    }

    const buffer = buffers.get(session);
    if (buffer === undefined) {
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
    const events = buffer.events;
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
        persistKnowledgeCandidates(repository, {
          sessionId,
          scope,
          events,
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
