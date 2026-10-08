import {
  MAX_CANDIDATES_PER_TURN,
  MAX_CANDIDATE_CONTENT_CHARS,
  MAX_EXTRACTION_EVENTS,
  MAX_EXTRACTION_EVENT_CHARS,
  MAX_EXTRACTION_TOTAL_CHARS,
  containsSensitiveContent,
  validateExtractionInput,
} from "./extraction.js";
import type {
  ExtractionEventReference,
  KnowledgeCandidateProposal,
  KnowledgeDetectionResult,
  KnowledgeExtractionInput,
} from "./extraction.js";

/** Transient caller assertion of reference intent: half-open original event.text UTF-16 offsets. */
export type LessonReferenceSpan = Readonly<{
  start: number;
  end: number;
}>;

export type LessonExtractionEventReference =
  ExtractionEventReference & {
    /** At most four assertions, never copied into proposals or evidence. */
    readonly referenceSpans?: readonly LessonReferenceSpan[];
  };

export type LessonExtractionInput =
  Omit<KnowledgeExtractionInput, "events"> & {
    readonly events: readonly LessonExtractionEventReference[];
  };

/** @internal Transient grammar metadata for Harness outcome association. */
export type LessonCandidateWithActionReference = Readonly<{
  proposal: KnowledgeCandidateProposal;
  sequence: number;
  actionReference?: string;
}>;

/** @internal Extended detector result; action references are never persisted. */
export type LessonCorrelationDetectionResult = Readonly<{
  candidates: readonly LessonCandidateWithActionReference[];
  sensitiveCount: number;
}>;

export const MAX_LESSON_SESSION_ID_CHARS = 128;
const MAX_REFERENCE_SPANS = 4;
const WEAK_LANGUAGE = /\b(?:maybe|perhaps|probably|possibly|potentially|might|could|someday|prefer|preferred|favorite|currently|temporarily|temporary|(?:for|in) (?:this|the current) (?:task|run|session|attempt|turn|change)|until|today)\b/i;
// Match whole qualifiers, including spaced/hyphenated phrases, without matching named-reference substrings.
const ONE_OFF_LANGUAGE = /(?<![A-Za-z0-9_./-])(?:(?:just|only)[ -]+once|once|(?:this|one)[ -]+time|one[ -]+off|(?:for|right)[ -]+now|now|tomorrow)(?:[ -]+only)?(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_./-])/i;
const INFRASTRUCTURE = /\b(?:network (?:error|failure|outage)|registry (?:error|failure|outage)|github outage|service outage|transient|rate[- ]limit(?:ed|ing)?|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENOTFOUND)\b/i;
const RAW_TEXT = /[\r\n]|\x60{3}|~~~|^(?:\[[A-Z]+\]|\$\s|Traceback\b|(?:\w*Error|Exception):|assistant:|tool:)|\bat\s+\S+\s*\(/i;
const CLAUSE_WORDS = /\b(?:and|but|because|which|that|then|if|when|unless|while|before|after|for|in|not|never|please|said|says?|claims?|passed|succeeded|fixed|resolved|verified|success(?:ful|fully)?)\b/i;
const REFERENCE_SURFACE = /^[A-Za-z0-9_./-]+(?:\s+[A-Za-z0-9_./-]+){0,7}$/;
const ATOM_CHARACTER = /[A-Za-z0-9_./-]/;
const STRUCTURAL_REFERENCE = /^[A-Za-z0-9_]+[./_-][A-Za-z0-9_./-]+$/;
const PROJECT_STEP = /^(?:generat(?:e|ion|ing)|typecheck(?:ing)?|build(?:ing)?|compil(?:e|ation|ing)|test(?:s|ing)?|lint(?:ing)?|migrat(?:e|ion|ions|ing)|install(?:ation)?|initializ(?:e|ation|ing))$/i;
const REFERENCE_WORD = /^(?:the|this|our|a|an|direct|directly|calls?|schema|source|code|npm|pnpm|yarn|run|running|project|repository|repo|package|backend|frontend|helper|api|provider|routing|selection)$/i;

/**
 * Pure, lesson-only detection from bounded, normalized human references.
 * M6.2 must enforce live append/source.kind === "user" before creating these references.
 * Alphabetic names require caller assertions; assertions do not prove symbol existence.
 * No outcome or causal fact is inferred, and no input text is logged.
 */
export function extractLessonCandidates(input: LessonExtractionInput): KnowledgeDetectionResult {
  const detection = extractLessonCandidatesWithActionReferences(input);
  return {
    candidates: detection.candidates.map(({ proposal }) => proposal),
    sensitiveCount: detection.sensitiveCount,
  };
}

/**
 * Runs the same M6.1 detector and additionally exposes its grammar-selected
 * action reference for transient Harness correlation. It does not broaden
 * acceptance and never copies assertion metadata into a proposal.
 */
export function extractLessonCandidatesWithActionReferences(
  input: LessonExtractionInput,
): LessonCorrelationDetectionResult {
  validateExtractionInput(input);
  if (input.sessionId.length > MAX_LESSON_SESSION_ID_CHARS) {
    throw new RangeError("Lesson session ID exceeds the reference limit.");
  }
  const candidates: LessonCandidateWithActionReference[] = [];
  let sensitiveCount = 0;
  let characters = 0;
  const sensitiveSession = containsSensitiveContent(input.sessionId);

  for (const event of input.events.slice(0, MAX_EXTRACTION_EVENTS)) {
    if (event.kind !== "user_message" || event.author !== "human" || event.text === undefined) {
      continue;
    }
    // Charge oversized input to the budget, but never accept a truncated prefix.
    characters += Math.min(event.text.length, MAX_EXTRACTION_EVENT_CHARS);
    if (characters > MAX_EXTRACTION_TOTAL_CHARS) break;
    if (event.text.length > MAX_EXTRACTION_EVENT_CHARS) continue;
    if (sensitiveSession || containsSensitiveContent(event.text)) {
      sensitiveCount += 1;
      continue;
    }
    const content = event.text.trim();
    // Language matching treats whitespace alike; stored content and grammar retain the user's wording.
    const language = content.replace(/\s+/g, " ");
    if (
      content.length < 12 || content.length > MAX_CANDIDATE_CONTENT_CHARS ||
      content.includes("?") || WEAK_LANGUAGE.test(language) || ONE_OFF_LANGUAGE.test(language) ||
      INFRASTRUCTURE.test(content) || RAW_TEXT.test(content)
    ) {
      continue;
    }
    const actionReference = acceptedActionReference(content, event.text, event.referenceSpans);
    if (actionReference === null) continue;
    const proposal: KnowledgeCandidateProposal = {
      type: "lesson",
      content,
      evidence: [{
        type: "session",
        source: input.sessionId,
        locator: "seq=" + event.sequence,
        timestamp: event.timestamp,
      }],
    };
    candidates.push({
      proposal,
      sequence: event.sequence,
      ...(actionReference === undefined ? {} : { actionReference }),
    });
    if (candidates.length === MAX_CANDIDATES_PER_TURN) break;
  }
  return { candidates, sensitiveCount };
}

function acceptedActionReference(content: string, text: string, metadata: unknown): string | undefined | null {
  const spans = validateReferenceSpans(text, metadata);
  if (spans === null) return null;
  // These changes are for matching only; stored content retains the user's wording.
  const withoutEnding = content.replace(/[.!]$/, "").trimEnd();
  const prefixLength = withoutEnding.match(/^(?:correction|actually|no)[,:]\s*/i)?.[0].length ?? 0;
  const statement = withoutEnding.slice(prefixLength);
  const offset = text.length - text.trimStart().length + prefixLength;
  const prohibition = statement.match(/^(?:don't|do not|never)\s+(?:call|use|invoke|run)\s+(.+?)[;.]\s*(?:use|call|run)\s+(.+)$/di);
  if (prohibition !== null) return contrastActionReference(prohibition, 2, offset, spans);
  const instead = statement.match(/^instead of (?:using|calling|running)\s+(.+?),\s*(?:use|call|run)\s+(.+)$/di);
  if (instead !== null) return contrastActionReference(instead, 2, offset, spans);
  const wrong = statement.match(/^(.+?) is (?:wrong|incorrect) here[;.]\s*(?:use|call|run)\s+(.+)$/di);
  if (wrong !== null) return contrastActionReference(wrong, 2, offset, spans);
  const replacement = statement.match(/^(?:always\s+)?(?:use|call|run)\s+(.+?)\s+(?:instead of|rather than)\s+(?:(?:using|calling|running)\s+)?(.+)$/di);
  if (replacement !== null) return contrastActionReference(replacement, 1, offset, spans);
  const constraint = statement.match(/^(?:provider selection|routing|(?:this|the|our) (?:project|repository|repo)) must (?:use|call|route through)\s+(.+?)\s+(?:instead of|rather than)\s+(?:(?:using|calling)\s+)?(.+)$/di);
  if (constraint !== null) return contrastActionReference(constraint, 1, offset, spans);

  const prerequisite = statement.match(/^(?:this|the|our) (?:repository|repo|project) requires\s+(.+?)\s+before\s+(.+)$/di)
    ?? statement.match(/^run\s+(.+?)\s+before\s+(.+?)\s+in (?:this|the|our) (?:project|repository|repo)$/di);
  if (prerequisite !== null) {
    const references = concreteReferences(prerequisite, offset, spans);
    return references !== null &&
      referenceKey(prerequisite[1]!) !== referenceKey(prerequisite[2]!)
      ? undefined
      : null;
  }

  const causal = statement.match(/^(.+?) (?:fails?|breaks?) (?:when|because)\s+(.+?) (?:is|are) (?:omitted|missing)[;.]\s*(?:include|add|restore|enable|run)\s+(.+?)(?:\s+before\s+(.+))?$/di);
  if (causal === null) return null;
  const references = concreteReferences(causal, offset, spans);
  return references !== null && referenceKey(causal[2]!) === referenceKey(causal[3]!)
    ? references[3]
    : null;
}

function contrastActionReference(
  match: RegExpMatchArray,
  actionSlot: number,
  offset: number,
  spans: readonly LessonReferenceSpan[],
): string | null {
  const references = concreteReferences(match, offset, spans);
  return references !== null && referenceKey(match[1]!) !== referenceKey(match[2]!)
    ? references[actionSlot]!
    : null;
}

function validateReferenceSpans(text: string, value: unknown): readonly LessonReferenceSpan[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_SPANS) return null;
  const count = value.length;
  const spans: LessonReferenceSpan[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== "object") return null;
    const { start, end } = item as LessonReferenceSpan;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || start >= end || end > text.length ||
        splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) return null;
    spans.push({ start, end });
  }
  spans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index - 1]!.end > spans[index]!.start) return null;
  }
  return spans;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function concreteReferences(
  match: RegExpMatchArray,
  offset: number,
  spans: readonly LessonReferenceSpan[],
): readonly (string | undefined)[] | null {
  const asserted = new Set<number>();
  const identities: Array<string | undefined> = [];
  for (const span of spans) {
    let capture: number | undefined;
    for (let index = 1; index < match.length; index += 1) {
      const range = match.indices![index];
      if (range !== undefined && span.start >= offset + range[0] && span.end <= offset + range[1]) {
        if (capture !== undefined) return null;
        capture = index;
      }
    }
    if (capture === undefined || asserted.has(capture)) return null;
    const range = match.indices![capture]!;
    const value = match[capture]!;
    const start = span.start - offset - range[0];
    const end = span.end - offset - range[0];
    if (!REFERENCE_SURFACE.test(value.slice(start, end)) ||
        (start > 0 && ATOM_CHARACTER.test(value[start - 1]!)) ||
        (end < value.length && ATOM_CHARACTER.test(value[end]!))) return null;
    asserted.add(capture);
    identities[capture] = value.slice(start, end).trim();
  }
  for (let index = 1; index < match.length; index += 1) {
    const value = match[index];
    if (value === undefined) continue;
    if (!isConcrete(value, asserted.has(index))) return null;
    if (identities[index] === undefined) identities[index] = value.trim();
  }
  return identities;
}

function isConcrete(value: string, asserted: boolean): boolean {
  if (
    !REFERENCE_SURFACE.test(value) ||
    /[.!](?:\s|$)/.test(value) || CLAUSE_WORDS.test(value)
  ) {
    return false;
  }
  // Assertions establish intent, including generic-looking names; they do not prove existence.
  if (asserted) return true;
  // Alphabetic spelling/casing is never evidence. Glue words need a structural/workflow atom.
  const words = value.split(/\s+/);
  return words.every((word) =>
    STRUCTURAL_REFERENCE.test(word) || PROJECT_STEP.test(word) || REFERENCE_WORD.test(word)) &&
    words.some((word) =>
      STRUCTURAL_REFERENCE.test(word) || PROJECT_STEP.test(word));
}

function referenceKey(value: string): string {
  return value.trim().replace(/^(?:the|this|our|a|an)\s+/i, "")
    .replace(/\s+directly$/i, "").replace(/\s+/g, " ").toLowerCase();
}
