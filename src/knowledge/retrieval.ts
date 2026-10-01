import type { KnowledgeRepository } from "./repository.js";
import type {
  Knowledge,
  KnowledgeStatus,
  KnowledgeType,
} from "./types.js";

const ACTIVE_STATUSES = ["verified", "candidate"] as const;
const MAX_QUERY_CHARACTERS = 1_200;
const MAX_QUERY_TOKENS = 16;
const DEFAULT_RESULT_LIMIT = 20;
export const MAX_RETRIEVAL_RESULTS = 100;
const MIN_PARTIAL_TOKEN_LENGTH = 4;
const MIN_SIMILARITY_TOKENS = 8;

/**
 * Score dimensions are intentionally hierarchical: textual relevance always
 * outweighs scope, scope outweighs status, and each later dimension is only a
 * tie-break against the dimensions before it.
 */
export const RETRIEVAL_SCORING = Object.freeze({
  exactPhrase: 1_000,
  exactToken: 100,
  partialToken: 40,
  fullTokenCoverage: 400,
  textMultiplier: 10_000,
  projectScopeMultiplier: 1_000,
  verifiedStatusMultiplier: 100,
  preferredTypeMultiplier: 10,
  evidenceItemContribution: 1,
  maxEvidenceContribution: 3,
  similarityThreshold: 0.9,
  freshnessBucketsDays: Object.freeze([
    Object.freeze({ max: 7, score: 4 }),
    Object.freeze({ max: 30, score: 3 }),
    Object.freeze({ max: 180, score: 2 }),
  ]),
  olderFreshnessScore: 1,
});

const STOP_WORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "between", "both", "but",
  "by", "can", "cannot", "could", "did", "do", "does", "doing", "down", "during",
  "each", "few", "for", "from", "further", "get", "got", "had", "has", "have", "having",
  "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "just", "make", "me", "more", "most", "my", "need", "nor",
  "now", "of", "off", "on", "once", "or", "other", "our", "out", "over", "own",
  "please", "same", "she", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "us", "use", "used", "using", "very", "want", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

const CONTRAST_TOKENS = new Set([
  "allow", "always", "avoid", "can", "cannot", "could", "disallow", "except", "forbid", "may",
  "might", "must", "never", "no", "not", "only", "optional", "prohibit", "required", "shall",
  "should", "unless", "will", "without", "would",
]);

export type RetrievalStatus = Extract<KnowledgeStatus, "candidate" | "verified">;

export type KnowledgeRetrievalOptions = {
  /** Workspace is required so retrieval can never search across workspaces. */
  workspace: string;
  /** A project includes matching project knowledge and workspace-wide knowledge. */
  project?: string | null;
  type?: KnowledgeType;
  /** Restrict results to a preferred lifecycle state; terminal states are never eligible. */
  status?: RetrievalStatus;
  /** Earlier types receive a small, deterministic tie-break contribution. */
  preferredTypes?: readonly KnowledgeType[];
  /** Result count is capped at {@link MAX_RETRIEVAL_RESULTS}. */
  limit?: number;
};

export type KnowledgeMatchType =
  | "exact_phrase"
  | "exact_tokens"
  | "mixed_tokens"
  | "partial_tokens";

export type KnowledgeRetrievalContributions = {
  exactPhrase: number;
  exactTokens: number;
  partialTokens: number;
  tokenCoverage: number;
  text: number;
  scope: number;
  status: number;
  type: number;
  evidence: number;
  freshness: number;
};

export type RankedKnowledge = {
  knowledge: Knowledge;
  /** Composite integer score; its dimensions are lexicographically weighted. */
  score: number;
  explanation: {
    matchType: KnowledgeMatchType;
    matchedTokens: string[];
    tokenCoverage: number;
    contributions: KnowledgeRetrievalContributions;
    /** IDs omitted as conservative near-duplicates of this result. */
    suppressedSimilarIds: string[];
  };
};

type TextMatch = {
  exactPhrase: boolean;
  exactTokens: string[];
  partialTokens: string[];
  matchedTokens: string[];
  tokenCoverage: number;
  textScore: number;
  matchType: KnowledgeMatchType;
};

/**
 * Deterministic local retrieval over the active, explicitly scoped corpus.
 * The existing repository LIKE search remains available with its old semantics.
 */
export function retrieveRelevantKnowledge(
  repository: KnowledgeRepository,
  query: string,
  options: KnowledgeRetrievalOptions,
): RankedKnowledge[] {
  validateOptions(options);
  if (typeof query !== "string") {
    throw new TypeError("Retrieval query must be a string.");
  }

  const boundedQuery = query.slice(0, MAX_QUERY_CHARACTERS);
  const normalizedQuery = normalizeText(boundedQuery);
  const queryTokens = [...new Set(tokenize(normalizedQuery)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)))].slice(0, MAX_QUERY_TOKENS);
  if (queryTokens.length === 0) {
    return [];
  }

  const candidates = loadCandidates(repository, options);
  const matches: Array<{ knowledge: Knowledge; text: TextMatch }> = [];
  for (const knowledge of candidates) {
    const text = matchText(normalizedQuery, queryTokens, knowledge.content);
    if (text.matchedTokens.length > 0) {
      matches.push({ knowledge, text });
    }
  }

  if (matches.length === 0) {
    return [];
  }

  const newestMatchTime = matches.reduce((newest, { knowledge }) => {
    const updatedAt = Date.parse(knowledge.updatedAt);
    return Number.isFinite(updatedAt) ? Math.max(newest, updatedAt) : newest;
  }, Number.NEGATIVE_INFINITY);
  const ranked = matches.map(({ knowledge, text }) => rankKnowledge(
    knowledge,
    text,
    options,
    newestMatchTime,
  ));
  ranked.sort(compareRankedKnowledge);

  const resultLimit = Math.min(
    options.limit ?? DEFAULT_RESULT_LIMIT,
    MAX_RETRIEVAL_RESULTS,
  );
  return suppressSimilarResults(ranked, resultLimit);
}

function loadCandidates(
  repository: KnowledgeRepository,
  options: KnowledgeRetrievalOptions,
): Knowledge[] {
  const byId = new Map<string, Knowledge>();
  const scopes: Array<string | null> = options.project !== undefined && options.project !== null
    ? [options.project, null]
    : [null];
  const statuses: readonly RetrievalStatus[] = options.status === undefined
    ? ACTIVE_STATUSES
    : [options.status];

  for (const status of statuses) {
    for (const project of scopes) {
      for (const knowledge of repository.list({
        workspace: options.workspace,
        project,
        type: options.type,
        status,
      })) {
        byId.set(knowledge.id, knowledge);
      }
    }
  }
  return [...byId.values()].filter((knowledge) =>
    !(knowledge.status === "candidate" && knowledge.creationOrigin === "automatic"));
}

function matchText(
  normalizedQuery: string,
  queryTokens: readonly string[],
  content: string,
): TextMatch {
  const normalizedContent = normalizeText(content);
  const contentTokens = tokenize(normalizedContent);
  const exactTokens: string[] = [];
  const partialTokens: string[] = [];

  for (const queryToken of queryTokens) {
    if (contentTokens.includes(queryToken)) {
      exactTokens.push(queryToken);
    } else if (
      queryToken.length >= MIN_PARTIAL_TOKEN_LENGTH &&
      contentTokens.some((contentToken) => contentToken.length >= MIN_PARTIAL_TOKEN_LENGTH &&
        (contentToken.includes(queryToken) || queryToken.includes(contentToken)))
    ) {
      partialTokens.push(queryToken);
    }
  }

  const matchedTokens = [...exactTokens, ...partialTokens];
  const exactPhrase = hasPhrase(normalizedContent, normalizedQuery);
  const tokenCoverage = matchedTokens.length / queryTokens.length;
  const exactPhraseScore = exactPhrase ? RETRIEVAL_SCORING.exactPhrase : 0;
  const exactTokenScore = exactTokens.length * RETRIEVAL_SCORING.exactToken;
  const partialTokenScore = partialTokens.length * RETRIEVAL_SCORING.partialToken;
  const tokenCoverageScore = Math.round(
    RETRIEVAL_SCORING.fullTokenCoverage * tokenCoverage,
  );
  const textScore = exactPhraseScore + exactTokenScore + partialTokenScore + tokenCoverageScore;
  const matchType: KnowledgeMatchType = exactPhrase
    ? "exact_phrase"
    : exactTokens.length > 0 && partialTokens.length > 0
      ? "mixed_tokens"
      : exactTokens.length > 0
        ? "exact_tokens"
        : "partial_tokens";

  return {
    exactPhrase,
    exactTokens,
    partialTokens,
    matchedTokens,
    tokenCoverage,
    textScore,
    matchType,
  };
}

function rankKnowledge(
  knowledge: Knowledge,
  text: TextMatch,
  options: KnowledgeRetrievalOptions,
  newestMatchTime: number,
): RankedKnowledge {
  const scope = options.project !== undefined && options.project !== null &&
    knowledge.scope.project === options.project ? 1 : 0;
  const status = knowledge.status === "verified" ? 1 : 0;
  const preferredTypes = options.preferredTypes ?? [];
  const preferenceIndex = preferredTypes.indexOf(knowledge.type);
  const type = preferenceIndex === -1 ? 0 : preferredTypes.length - preferenceIndex;
  const evidence = Math.min(
    knowledge.evidence.length,
    RETRIEVAL_SCORING.maxEvidenceContribution,
  ) * RETRIEVAL_SCORING.evidenceItemContribution;
  const freshness = freshnessContribution(knowledge.updatedAt, newestMatchTime);

  const contributions: KnowledgeRetrievalContributions = {
    exactPhrase: text.exactPhrase ? RETRIEVAL_SCORING.exactPhrase : 0,
    exactTokens: text.exactTokens.length * RETRIEVAL_SCORING.exactToken,
    partialTokens: text.partialTokens.length * RETRIEVAL_SCORING.partialToken,
    tokenCoverage: Math.round(RETRIEVAL_SCORING.fullTokenCoverage * text.tokenCoverage),
    text: text.textScore,
    scope: scope * RETRIEVAL_SCORING.projectScopeMultiplier,
    status: status * RETRIEVAL_SCORING.verifiedStatusMultiplier,
    type: type * RETRIEVAL_SCORING.preferredTypeMultiplier,
    evidence,
    freshness,
  };
  const score =
    text.textScore * RETRIEVAL_SCORING.textMultiplier +
    contributions.scope +
    status * RETRIEVAL_SCORING.verifiedStatusMultiplier +
    type * RETRIEVAL_SCORING.preferredTypeMultiplier +
    evidence +
    freshness;

  return {
    knowledge,
    score,
    explanation: {
      matchType: text.matchType,
      matchedTokens: text.matchedTokens,
      tokenCoverage: roundCoverage(text.tokenCoverage),
      contributions,
      suppressedSimilarIds: [],
    },
  };
}

function freshnessContribution(updatedAt: string, newestMatchTime: number): number {
  const updatedTime = Date.parse(updatedAt);
  if (!Number.isFinite(updatedTime) || !Number.isFinite(newestMatchTime)) {
    return RETRIEVAL_SCORING.olderFreshnessScore;
  }
  const ageDays = Math.max(0, newestMatchTime - updatedTime) / 86_400_000;
  for (const bucket of RETRIEVAL_SCORING.freshnessBucketsDays) {
    if (ageDays <= bucket.max) {
      return bucket.score;
    }
  }
  return RETRIEVAL_SCORING.olderFreshnessScore;
}

function compareRankedKnowledge(left: RankedKnowledge, right: RankedKnowledge): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const updatedOrder = compareTimestampDescending(
    left.knowledge.updatedAt,
    right.knowledge.updatedAt,
  );
  if (updatedOrder !== 0) {
    return updatedOrder;
  }
  const createdOrder = compareTimestampDescending(
    left.knowledge.createdAt,
    right.knowledge.createdAt,
  );
  if (createdOrder !== 0) {
    return createdOrder;
  }
  return compareStrings(left.knowledge.id, right.knowledge.id);
}

function suppressSimilarResults(
  ranked: readonly RankedKnowledge[],
  limit: number,
): RankedKnowledge[] {
  const selected: RankedKnowledge[] = [];
  for (const candidate of ranked) {
    const duplicateOf = selected.find((item) => areConservativeDuplicates(
      item.knowledge,
      candidate.knowledge,
    ));
    if (duplicateOf !== undefined) {
      duplicateOf.explanation.suppressedSimilarIds.push(candidate.knowledge.id);
      continue;
    }
    if (selected.length === limit) {
      break;
    }
    selected.push(candidate);
  }
  return selected;
}

/** M2's existing conservative duplicate predicate, shared with candidate admission. */
export function areConservativeDuplicates(
  left: Pick<Knowledge, "type" | "content" | "scope">,
  right: Pick<Knowledge, "type" | "content" | "scope">,
): boolean {
  if (
    left.type !== right.type ||
    left.scope.workspace !== right.scope.workspace ||
    (left.scope.project ?? null) !== (right.scope.project ?? null)
  ) {
    return false;
  }

  const leftTokens = tokenize(normalizeText(left.content));
  const rightTokens = tokenize(normalizeText(right.content));
  if (leftTokens.join(" ") === rightTokens.join(" ")) {
    return true;
  }
  if (Math.min(leftTokens.length, rightTokens.length) < MIN_SIMILARITY_TOKENS) {
    return false;
  }
  if (!isTokenSubsequence(leftTokens, rightTokens) && !isTokenSubsequence(rightTokens, leftTokens)) {
    return false;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  for (const token of CONTRAST_TOKENS) {
    if (leftSet.has(token) !== rightSet.has(token)) {
      return false;
    }
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 && intersection / union >= RETRIEVAL_SCORING.similarityThreshold;
}

function isTokenSubsequence(shorter: readonly string[], longer: readonly string[]): boolean {
  let shorterIndex = 0;
  for (const token of longer) {
    if (token === shorter[shorterIndex]) {
      shorterIndex += 1;
      if (shorterIndex === shorter.length) {
        return true;
      }
    }
  }
  return shorterIndex === shorter.length;
}

function hasPhrase(normalizedContent: string, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) {
    return false;
  }
  return (` ${normalizedContent} `).includes(` ${normalizedQuery} `);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(normalizedText: string): string[] {
  return normalizedText.length === 0 ? [] : normalizedText.split(" ");
}

function roundCoverage(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function validateOptions(options: KnowledgeRetrievalOptions): void {
  if (typeof options?.workspace !== "string" || options.workspace.trim().length === 0) {
    throw new TypeError("Retrieval options must include a non-empty workspace.");
  }
  if (options.project !== undefined && options.project !== null &&
    (typeof options.project !== "string" || options.project.trim().length === 0)) {
    throw new TypeError("Project scope must be a non-empty string when provided.");
  }
  if (options.type !== undefined && !["fact", "decision", "lesson"].includes(options.type)) {
    throw new TypeError(`Invalid knowledge type: ${String(options.type)}`);
  }
  if (options.status !== undefined && !ACTIVE_STATUSES.includes(options.status)) {
    throw new TypeError(`Invalid retrieval status: ${String(options.status)}`);
  }
  if (options.preferredTypes !== undefined) {
    if (!Array.isArray(options.preferredTypes) || options.preferredTypes.some(
      (type) => !["fact", "decision", "lesson"].includes(type),
    ) || new Set(options.preferredTypes).size !== options.preferredTypes.length ||
      options.preferredTypes.length > 3) {
      throw new TypeError("Preferred knowledge types must be unique valid types.");
    }
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new RangeError("Retrieval limit must be a positive integer.");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTimestampDescending(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return compareStrings(right, left);
}
