export { KnowledgeRepository } from "./knowledge/repository.js";
export {
  captureFileProvenance,
  compareFileSnapshots,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_OPERATION_BUDGET_MS,
  MAX_GIT_EVIDENCE_CHECKS,
  MAX_GIT_PATH_CHARS,
  normalizeGitCommit,
  normalizeRepositoryRelativePath,
} from "./knowledge/git.js";
export { checkKnowledgeFreshness } from "./knowledge/freshness.js";
export {
  MAX_RETRIEVAL_RESULTS,
  RETRIEVAL_SCORING,
  retrieveRelevantKnowledge,
} from "./knowledge/retrieval.js";
export { KnowledgeStore } from "./knowledge/store.js";

export type {
  CreateKnowledgeInput,
  Evidence,
  EvidenceType,
  GitProvenance,
  Knowledge,
  KnowledgeListOptions,
  KnowledgePatch,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
} from "./knowledge/types.js";

export type {
  CaptureFileProvenanceOptions,
  CompareFileSnapshotsOptions,
  FileProvenanceCapture,
  FileSnapshotComparison,
  GitCommandFailure,
  GitCommandResult,
  GitCommandRunner,
  GitInspectionOptions,
  GitOperationReason,
} from "./knowledge/git.js";

export type {
  CheckKnowledgeFreshnessOptions,
  EvidenceFreshness,
  FreshnessReason,
  FreshnessStatus,
  KnowledgeFreshnessReport,
} from "./knowledge/freshness.js";

export type {
  KnowledgeMatchType,
  KnowledgeRetrievalContributions,
  KnowledgeRetrievalOptions,
  RankedKnowledge,
  RetrievalStatus,
} from "./knowledge/retrieval.js";
