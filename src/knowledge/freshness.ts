import {
  compareFileSnapshots,
  MAX_GIT_EVIDENCE_CHECKS,
} from "./git.js";
import type {
  FileSnapshotComparison,
  GitInspectionOptions,
  GitOperationReason,
} from "./git.js";
import type { Evidence, Knowledge } from "./types.js";

export type FreshnessStatus = "current" | "potentially_stale" | "unverifiable";

export type EvidenceFreshness = {
  evidenceIndex: number;
  type: Evidence["type"];
  status: FreshnessStatus;
  reason?: FreshnessReason;
};

export type FreshnessReason =
  | GitOperationReason
  | "missing_git_provenance"
  | "not_file_evidence";

export type KnowledgeFreshnessReport = {
  knowledgeId: string;
  checkedAt: string;
  status: FreshnessStatus;
  /** Aggregate applies only to Git-backed file evidence; entries explain every evidence record. */
  evidence: EvidenceFreshness[];
};

export type CheckKnowledgeFreshnessOptions = GitInspectionOptions & {
  /** Explicit directory from the caller; scope.workspace is not assumed to be a path. */
  workspaceDirectory: string;
};

/**
 * Read-only freshness check. It reports whether Git-backed file snapshots
 * still match their recorded commit; it never changes the knowledge lifecycle.
 */
export async function checkKnowledgeFreshness(
  knowledge: Knowledge,
  options: CheckKnowledgeFreshnessOptions,
): Promise<KnowledgeFreshnessReport> {
  const evidence: EvidenceFreshness[] = knowledge.evidence.map((item, evidenceIndex) => ({
    evidenceIndex,
    type: item.type,
    status: "unverifiable",
    reason: item.type === "session" ? "not_file_evidence" : "missing_git_provenance",
  }));

  const backedFileEvidence: Array<{ index: number; item: Evidence }> = [];
  for (let index = 0; index < knowledge.evidence.length; index += 1) {
    const item = knowledge.evidence[index]!;
    if (item.type === "file" && item.gitProvenance !== undefined) {
      backedFileEvidence.push({ index, item });
    } else if (item.gitProvenance !== undefined) {
      evidence[index] = {
        evidenceIndex: index,
        type: item.type,
        status: "unverifiable",
        reason: "not_file_evidence",
      };
    }
  }

  const toCheck = backedFileEvidence.slice(0, MAX_GIT_EVIDENCE_CHECKS);
  const comparisons: FileSnapshotComparison[] = await compareFileSnapshots({
    workspaceDirectory: options.workspaceDirectory,
    provenances: toCheck.map(({ item }) => item.gitProvenance!),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.operationBudgetMs === undefined ? {} : { operationBudgetMs: options.operationBudgetMs }),
  });

  comparisons.forEach((comparison, comparisonIndex) => {
    const target = toCheck[comparisonIndex]!;
    evidence[target.index] = {
      evidenceIndex: target.index,
      type: target.item.type,
      status: comparison.status,
      ...(comparison.reason === undefined ? {} : { reason: comparison.reason }),
    };
  });
  for (const target of backedFileEvidence.slice(MAX_GIT_EVIDENCE_CHECKS)) {
    evidence[target.index] = {
      evidenceIndex: target.index,
      type: target.item.type,
      status: "unverifiable",
      reason: "operation_budget_exceeded",
    };
  }

  const status = aggregateFreshness(backedFileEvidence.map(({ index }) => evidence[index]!));
  return {
    knowledgeId: knowledge.id,
    checkedAt: new Date().toISOString(),
    status,
    evidence,
  };
}

function aggregateFreshness(results: readonly EvidenceFreshness[]): FreshnessStatus {
  if (results.length === 0) {
    return "unverifiable";
  }
  if (results.some(({ status }) => status === "potentially_stale")) {
    return "potentially_stale";
  }
  if (results.some(({ status }) => status === "unverifiable")) {
    return "unverifiable";
  }
  return "current";
}
