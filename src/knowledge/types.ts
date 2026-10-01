export type KnowledgeType = "fact" | "decision" | "lesson";

export type KnowledgeStatus =
  | "candidate"
  | "verified"
  | "superseded"
  | "archived";

export type KnowledgeScope = {
  workspace: string;
  project?: string;
};

export type EvidenceType = "session" | "file" | "git";

export type Evidence = {
  type: EvidenceType;
  source: string;
  locator?: string;
  timestamp: string;
};

export type Knowledge = {
  id: string;
  type: KnowledgeType;
  content: string;
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeInput = {
  type: KnowledgeType;
  content: string;
  scope: KnowledgeScope;
  evidence?: Evidence[];
};

export type KnowledgeListOptions = {
  workspace?: string;
  /** Use null to select workspace-wide entries without a project. */
  project?: string | null;
  type?: KnowledgeType;
  status?: KnowledgeStatus;
  limit?: number;
};

export type KnowledgePatch = Partial<
  Pick<Knowledge, "type" | "content" | "scope" | "status" | "evidence">
>;
