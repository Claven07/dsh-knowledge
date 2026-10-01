export { KnowledgeRepository } from "./knowledge/repository.js";
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
  Knowledge,
  KnowledgeListOptions,
  KnowledgePatch,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
} from "./knowledge/types.js";

export type {
  KnowledgeMatchType,
  KnowledgeRetrievalContributions,
  KnowledgeRetrievalOptions,
  RankedKnowledge,
  RetrievalStatus,
} from "./knowledge/retrieval.js";
