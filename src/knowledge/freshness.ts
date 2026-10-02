import {
  compareFileSnapshots,
  compareFileSnapshotsForHealth,
  MAX_GIT_EVIDENCE_CHECKS,
} from "./git.js";
import type { GitInspectionOptions, GitOperationReason } from "./git.js";
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

type EvaluatedEvidenceFreshness = Omit<EvidenceFreshness, "reason"> & {
  reason?: FreshnessReason | "source_path_missing";
};

type EvaluatedKnowledgeFreshnessReport = Omit<KnowledgeFreshnessReport, "evidence"> & {
  evidence: EvaluatedEvidenceFreshness[];
  overflowCount: number;
};

/** Internal shared result used by M3's single-record API and M5's batch health API. */
export type KnowledgeFreshnessBatchEvaluation = {
  checkedAt: string;
  reports: EvaluatedKnowledgeFreshnessReport[];
};

type BatchEvaluationOptions = {
  /** Maximum evidence rows materialized per item; omitted means preserve M3's full report. */
  maxEvidencePerKnowledge?: number;
  /** M5 may expose the richer path-missing reason without changing the M3 API. */
  missingPathReason?: "working_tree_changed" | "source_path_missing";
};

/**
 * Read-only freshness check. It reports whether Git-backed file snapshots
 * still match their recorded commit; it never changes the knowledge lifecycle.
 */
export async function checkKnowledgeFreshness(
  knowledge: Knowledge,
  options: CheckKnowledgeFreshnessOptions,
): Promise<KnowledgeFreshnessReport> {
  const evaluation = await evaluateKnowledgeFreshnessBatch([knowledge], options);
  const report = evaluation.reports[0]!;
  return {
    knowledgeId: report.knowledgeId,
    checkedAt: report.checkedAt,
    status: report.status,
    evidence: report.evidence.map((item): EvidenceFreshness => ({
      evidenceIndex: item.evidenceIndex,
      type: item.type,
      status: item.status,
      ...(item.reason === undefined
        ? {}
        : { reason: item.reason === "source_path_missing" ? "working_tree_changed" : item.reason }),
    })),
  };
}

/**
 * Shared bounded evaluator. A batch performs one Git comparison operation, so
 * evidence limits and the operation budget are shared across all records.
 */
export async function evaluateKnowledgeFreshnessBatch(
  knowledgeItems: readonly Knowledge[],
  options: CheckKnowledgeFreshnessOptions,
  evaluationOptions: BatchEvaluationOptions = {},
): Promise<KnowledgeFreshnessBatchEvaluation> {
  const evidenceLimit = evaluationOptions.maxEvidencePerKnowledge ?? Number.POSITIVE_INFINITY;
  if (evidenceLimit < 0 || (!Number.isInteger(evidenceLimit) && evidenceLimit !== Number.POSITIVE_INFINITY)) {
    throw new RangeError("The evidence detail limit must be a non-negative integer.");
  }

  const includedEvidence = knowledgeItems.map((knowledge) =>
    knowledge.evidence.slice(0, evidenceLimit),
  );
  const evidenceOverflowCounts = knowledgeItems.map((knowledge, index) =>
    knowledge.evidence.length - includedEvidence[index]!.length,
  );
  const evidence = includedEvidence.map((items) =>
    items.map((item, evidenceIndex): EvaluatedEvidenceFreshness => ({
      evidenceIndex,
      type: item.type,
      status: "unverifiable",
      reason: item.type === "session" ? "not_file_evidence" : "missing_git_provenance",
    })),
  );

  const backedFileEvidence: Array<{
    knowledgeIndex: number;
    evidenceIndex: number;
    item: Evidence;
  }> = [];
  const backedEvidenceIndexes = knowledgeItems.map(() => [] as number[]);
  for (let knowledgeIndex = 0; knowledgeIndex < knowledgeItems.length; knowledgeIndex += 1) {
    const items = includedEvidence[knowledgeIndex]!;
    for (let evidenceIndex = 0; evidenceIndex < items.length; evidenceIndex += 1) {
      const item = items[evidenceIndex]!;
      if (item.type === "file" && item.gitProvenance !== undefined) {
        backedFileEvidence.push({ knowledgeIndex, evidenceIndex, item });
        backedEvidenceIndexes[knowledgeIndex]!.push(evidenceIndex);
      } else if (item.gitProvenance !== undefined) {
        evidence[knowledgeIndex]![evidenceIndex] = {
          evidenceIndex,
          type: item.type,
          status: "unverifiable",
          reason: "not_file_evidence",
        };
      }
    }
  }

  const toCheck = backedFileEvidence.slice(0, MAX_GIT_EVIDENCE_CHECKS);
  const comparisonOptions = {
    workspaceDirectory: options.workspaceDirectory,
    provenances: toCheck.map(({ item }) => item.gitProvenance!),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.operationBudgetMs === undefined ? {} : { operationBudgetMs: options.operationBudgetMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const comparisons = evaluationOptions.missingPathReason === "source_path_missing"
    ? await compareFileSnapshotsForHealth(comparisonOptions)
    : await compareFileSnapshots(comparisonOptions);

  comparisons.forEach((comparison, comparisonIndex) => {
    const target = toCheck[comparisonIndex]!;
    evidence[target.knowledgeIndex]![target.evidenceIndex] = {
      evidenceIndex: target.evidenceIndex,
      type: target.item.type,
      status: comparison.status,
      ...(comparison.reason === undefined ? {} : {
        reason: comparison.reason === "source_path_missing"
          ? evaluationOptions.missingPathReason ?? "working_tree_changed"
          : comparison.reason,
      }),
    };
  });
  for (const target of backedFileEvidence.slice(MAX_GIT_EVIDENCE_CHECKS)) {
    evidence[target.knowledgeIndex]![target.evidenceIndex] = {
      evidenceIndex: target.evidenceIndex,
      type: target.item.type,
      status: "unverifiable",
      reason: "operation_budget_exceeded",
    };
  }

  const checkedAt = new Date().toISOString();
  const reports = knowledgeItems.map((knowledge, knowledgeIndex): EvaluatedKnowledgeFreshnessReport => {
    const backedResults = backedEvidenceIndexes[knowledgeIndex]!
      .map((evidenceIndex) => evidence[knowledgeIndex]![evidenceIndex]!);
    return {
      knowledgeId: knowledge.id,
      checkedAt,
      status: aggregateWithOverflow(backedResults, evidenceOverflowCounts[knowledgeIndex]!),
      evidence: evidence[knowledgeIndex]!,
      overflowCount: evidenceOverflowCounts[knowledgeIndex]!,
    };
  });

  return { checkedAt, reports };
}

function aggregateWithOverflow(
  results: readonly Pick<EvaluatedEvidenceFreshness, "status">[],
  overflowCount: number,
): FreshnessStatus {
  const status = aggregateFreshness(results);
  if (status === "potentially_stale" || overflowCount === 0) {
    return status;
  }
  return "unverifiable";
}

function aggregateFreshness(results: readonly Pick<EvaluatedEvidenceFreshness, "status">[]): FreshnessStatus {
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
