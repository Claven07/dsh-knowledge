import type { KnowledgeRepository } from "./repository.js";
import { areConservativeDuplicates } from "./retrieval.js";
import type { Evidence, Knowledge, KnowledgeScope, KnowledgeType } from "./types.js";

export const MAX_EXTRACTION_EVENTS = 8;
export const MAX_EXTRACTION_EVENT_CHARS = 1_200;
export const MAX_EXTRACTION_TOTAL_CHARS = 4_000;
export const MAX_CANDIDATES_PER_TURN = 2;
export const MAX_CANDIDATE_CONTENT_CHARS = 600;
export const MAX_DUPLICATE_CHECK_ITEMS = 200;

export type ExtractionAuthor = "human" | "synthetic" | "assistant" | "tool";
export type ExtractionEventKind = "user_message" | "assistant_message" | "tool_result";

/** Minimal, bounded event data. Text is transient input and is never stored as evidence. */
export type ExtractionEventReference = {
  sequence: number;
  timestamp: string;
  kind: ExtractionEventKind;
  author: ExtractionAuthor;
  text?: string;
  failed?: boolean;
};

export type KnowledgeExtractionInput = {
  sessionId: string;
  scope: KnowledgeScope;
  events: readonly ExtractionEventReference[];
};

export type KnowledgeCandidateProposal = {
  type: KnowledgeType;
  content: string;
  evidence: Evidence[];
};

export type KnowledgeExtractionResult = {
  created: Knowledge[];
  skipped: {
    sensitive: number;
    duplicate: number;
  };
};

export type KnowledgeDetectionResult = {
  candidates: KnowledgeCandidateProposal[];
  sensitiveCount: number;
};

type ClassifiedClaim = {
  type: KnowledgeType;
  content: string;
};

const DECISION_PREFIX = /^(?:(?:we|our team|the team)\s+(?:have\s+)?decided\s+(?:to\s+)?|decision\s*:\s*)/i;
const CORRECTION_PREFIX = /^(?:no|actually|correction|that(?:'s| is) incorrect|that(?:'s| is) not right)\s*[,;:\-—]?\s*/i;
const FAILURE_SIGNAL = /\b(?:failed|failure|blocked|blocking|hung|hangs|timed? out|broke|broken|error)\b/i;
const FIX_SIGNAL = /\b(?:fixed|fix(?:ed)? by|resolved by|the fix was|solved by|adding .{1,100} fixed|setting .{1,100} resolved)\b/i;
const CAUSAL_SIGNAL = /\b(?:because|caused by|so that|by adding|by setting|after adding|after setting)\b|;/i;
const DURABLE_CUE = /\b(?:project|repository|repo|application|app|backend|frontend|api|service|authentication|authorization|database|deployment|build|cache|routing|provider|package|codebase|supabase|render|postgres(?:ql)?|sqlite|mysql|mongodb|redis|dynamodb|typescript|javascript|node(?:\.js)?|python|rust|docker|kubernetes|github|git|react|next(?:\.js)?)\b/i;
const DESCRIPTIVE_START = /^(?:(?:this|the|our)\s+)?(?:project|repository|repo|application|app|backend|frontend|api|service|authentication|authorization|database|deployment|build|cache|routing|provider|package|codebase|supabase|render|postgres(?:ql)?|sqlite|mysql|mongodb|redis|dynamodb|typescript|javascript|node(?:\.js)?|python|rust|docker|kubernetes|github|git|react|next(?:\.js)?)\b/i;
const DESCRIPTIVE_VERB = /\b(?:is|are|uses?|runs?|stores?|implemented|built|configured|requires?|depends?|supports?|handles?|authorizes?|routes?)\b/i;
const CONSTRAINT_START = /^(?:(?:for\s+(?:this|the)\s+project[,]?\s+)?(?:we|the project|our (?:project|repository|repo|application|app|backend|frontend|api|service))\s+)(?:must|must not|should|should not|needs? to|has to|cannot|can't|never|always|requires?)\b/i;
const TEMPORARY_OR_SPECULATIVE = /\b(?:maybe|perhaps|probably|might|could|someday|for now|temporarily|for this task|just for this task|in this task)\b/i;
const CODE_BLOCK = /```|^\s*(?:import|export|class|function|const|let|var)\s+\w+/m;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|xai-[A-Za-z0-9_-]{20,})\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credential)\s*[:=]\s*["']?[^\s"']{3,}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
];

/** A conservative deterministic detector; it does not redact or log sensitive text. */
export function containsSensitiveContent(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/** Converts only explicit, bounded human statements into candidate proposals. */
export function extractKnowledgeCandidates(
  input: KnowledgeExtractionInput,
): KnowledgeDetectionResult {
  validateInput(input);
  const candidates: KnowledgeCandidateProposal[] = [];
  let sensitiveCount = 0;
  let totalCharacters = 0;

  for (const event of input.events.slice(0, MAX_EXTRACTION_EVENTS)) {
    if (event.kind !== "user_message" || event.author !== "human" || event.text === undefined) {
      continue;
    }
    const boundedText = event.text.slice(0, MAX_EXTRACTION_EVENT_CHARS);
    totalCharacters += boundedText.length;
    if (totalCharacters > MAX_EXTRACTION_TOTAL_CHARS) {
      break;
    }
    if (containsSensitiveContent(boundedText)) {
      sensitiveCount += 1;
      continue;
    }
    if (CODE_BLOCK.test(boundedText)) {
      continue;
    }

    const claim = classifyClaim(boundedText);
    if (claim === null || claim.content.length > MAX_CANDIDATE_CONTENT_CHARS) {
      continue;
    }
    candidates.push({
      ...claim,
      evidence: [{
        type: "session",
        source: input.sessionId,
        locator: `seq=${event.sequence}`,
        timestamp: event.timestamp,
      }],
    });
    if (candidates.length >= MAX_CANDIDATES_PER_TURN) {
      break;
    }
  }

  return { candidates, sensitiveCount };
}

/** Applies same-scope M2 similarity checks and writes automatic candidates only. */
export function persistKnowledgeCandidates(
  repository: KnowledgeRepository,
  input: KnowledgeExtractionInput,
): KnowledgeExtractionResult {
  const { candidates, sensitiveCount } = extractKnowledgeCandidates(input);
  const created: Knowledge[] = [];
  let duplicate = 0;

  for (const candidate of candidates) {
    const existing: Knowledge[] = [];
    for (const status of ["candidate", "verified"] as const) {
      existing.push(...repository.list({
        workspace: input.scope.workspace,
        project: input.scope.project ?? null,
        type: candidate.type,
        status,
        limit: MAX_DUPLICATE_CHECK_ITEMS,
      }));
    }
    if (existing.some((item) => areConservativeDuplicates(item, {
      type: candidate.type,
      content: candidate.content,
      scope: input.scope,
    }))) {
      duplicate += 1;
      continue;
    }

    // Unexpected repository/SQLite errors propagate to the queue's content-free handler.
    created.push(repository.create({
      type: candidate.type,
      content: candidate.content,
      scope: input.scope,
      evidence: candidate.evidence,
      creationOrigin: "automatic",
    }));
  }

  return { created, skipped: { sensitive: sensitiveCount, duplicate } };
}

function classifyClaim(text: string): ClassifiedClaim | null {
  const statement = firstStatement(text);
  if (
    statement === null ||
    statement.endsWith("?") ||
    statement.length < 12 ||
    TEMPORARY_OR_SPECULATIVE.test(statement)
  ) {
    return null;
  }

  if (FAILURE_SIGNAL.test(statement) && FIX_SIGNAL.test(statement) && CAUSAL_SIGNAL.test(statement)) {
    return { type: "lesson", content: statement };
  }

  const decision = statement.match(DECISION_PREFIX);
  if (decision !== null) {
    const proposition = statement.slice(decision[0].length).trim();
    if (isProjectSpecific(proposition)) {
      return { type: "decision", content: statement };
    }
  }

  const correction = statement.match(CORRECTION_PREFIX);
  if (correction !== null) {
    const corrected = statement.slice(correction[0].length).split(/;\s*(?=(?:please|do not|don't|never|always)\b)/i)[0]!.trim();
    if (isProjectSpecific(corrected) && DESCRIPTIVE_VERB.test(corrected)) {
      return { type: "fact", content: finishSentence(corrected) };
    }
  }

  if (CONSTRAINT_START.test(statement) && isProjectSpecific(statement)) {
    return { type: "decision", content: statement };
  }

  if (DESCRIPTIVE_START.test(statement) && DESCRIPTIVE_VERB.test(statement) && isProjectSpecific(statement)) {
    return { type: "fact", content: statement };
  }

  return null;
}

function firstStatement(text: string): string | null {
  const statement = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/u, 1)[0]
    ?.trim();
  if (statement === undefined || statement.length === 0) {
    return null;
  }
  return statement;
}

function isProjectSpecific(value: string): boolean {
  return DURABLE_CUE.test(value);
}

function finishSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function validateInput(input: KnowledgeExtractionInput): void {
  if (typeof input.sessionId !== "string" || input.sessionId.trim().length === 0) {
    throw new TypeError("Extraction input must include a session ID.");
  }
  if (typeof input.scope?.workspace !== "string" || input.scope.workspace.trim().length === 0) {
    throw new TypeError("Extraction input must include workspace scope.");
  }
  if (input.scope.project !== undefined &&
      (typeof input.scope.project !== "string" || input.scope.project.trim().length === 0)) {
    throw new TypeError("Extraction project scope must not be empty.");
  }
  if (!Array.isArray(input.events)) {
    throw new TypeError("Extraction events must be an array.");
  }
  for (const event of input.events.slice(0, MAX_EXTRACTION_EVENTS)) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new TypeError("Extraction event sequence must be a non-negative safe integer.");
    }
    if (!Number.isFinite(Date.parse(event.timestamp)) ||
        new Date(event.timestamp).toISOString() !== event.timestamp) {
      throw new TypeError("Extraction event timestamp must be valid ISO text.");
    }
    if (event.text !== undefined && typeof event.text !== "string") {
      throw new TypeError("Extraction event text must be a string when provided.");
    }
  }
}
