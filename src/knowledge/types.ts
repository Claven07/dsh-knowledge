export type KnowledgeType = "fact" | "decision" | "lesson";

export type KnowledgeStatus =
  | "candidate"
  | "verified"
  | "superseded"
  | "archived";

export type KnowledgeOrigin = "explicit" | "automatic";

export type KnowledgeScope = {
  workspace: string;
  project?: string;
};

export type EvidenceType = "session" | "file" | "git";

/** A file snapshot in a specific Git commit. Paths use Git's `/` separators. */
export type GitProvenance = {
  commit: string;
  path: string;
};

export type Evidence = {
  type: EvidenceType;
  source: string;
  locator?: string;
  timestamp: string;
  gitProvenance?: GitProvenance;
};

export type Knowledge = {
  id: string;
  type: KnowledgeType;
  content: string;
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  creationOrigin: KnowledgeOrigin;
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeInput = {
  type: KnowledgeType;
  content: string;
  scope: KnowledgeScope;
  evidence?: Evidence[];
  creationOrigin?: KnowledgeOrigin;
};

export type KnowledgeListOptions = {
  workspace?: string;
  /** Use null to select workspace-wide entries without a project. */
  project?: string | null;
  type?: KnowledgeType;
  status?: KnowledgeStatus;
  creationOrigin?: KnowledgeOrigin;
  limit?: number;
};

export type KnowledgePatch = Partial<
  Pick<Knowledge, "type" | "content" | "scope" | "status" | "evidence">
>;
