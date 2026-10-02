import {
  evaluateKnowledgeFreshnessBatch,
} from "./freshness.js";
import type {
  CheckKnowledgeFreshnessOptions,
  FreshnessReason,
  FreshnessStatus,
} from "./freshness.js";
import { MAX_GIT_EVIDENCE_CHECKS } from "./git.js";
import type { Evidence, Knowledge } from "./types.js";

export const MAX_HEALTH_BATCH_ITEMS = MAX_GIT_EVIDENCE_CHECKS;
const MAX_HEALTH_EVIDENCE_DETAILS_PER_ITEM = MAX_GIT_EVIDENCE_CHECKS;

export type KnowledgeHealthStatus = FreshnessStatus;

export type HealthReason =
  | FreshnessReason
  | "snapshot_matches"
  | "source_path_missing"
  | "evidence_overflow"
  | "no_git_backed_file_evidence"
  | "health_check_busy";

export type EvidenceHealth = {
  evidenceIndex: number;
  type: Evidence["type"];
  status: KnowledgeHealthStatus;
  reason: HealthReason;
};

export type KnowledgeHealth = {
  knowledgeId: string;
  checkedAt: string;
  status: KnowledgeHealthStatus;
  reasons: HealthReason[];
  evidence: EvidenceHealth[];
  /** Evidence records after the bounded detailed result window. */
  overflowCount: number;
};

export type KnowledgeHealthBatchReport = {
  checkedAt: string;
  results: KnowledgeHealth[];
};

export type CheckKnowledgeHealthOptions = CheckKnowledgeFreshnessOptions;

/**
 * Reports live, read-only health for one item. This describes evidence
 * consistency, not whether the knowledge claim is true or verified.
 */
export async function checkKnowledgeHealth(
  knowledge: Knowledge,
  options: CheckKnowledgeHealthOptions,
): Promise<KnowledgeHealth> {
  const report = await checkKnowledgeHealthBatch([knowledge], options);
  return report.results[0]!;
}

/**
 * Checks a bounded set of items in one workspace using one shared M3 Git
 * operation budget. The workspace directory is always supplied explicitly;
 * scope.workspace is only used to reject mixed logical workspaces.
 */
export async function checkKnowledgeHealthBatch(
  knowledgeItems: readonly Knowledge[],
  options: CheckKnowledgeHealthOptions,
): Promise<KnowledgeHealthBatchReport> {
  if (knowledgeItems.length > MAX_HEALTH_BATCH_ITEMS) {
    throw new RangeError(`A health batch may contain at most ${MAX_HEALTH_BATCH_ITEMS} items.`);
  }
  if (typeof options?.workspaceDirectory !== "string" || options.workspaceDirectory.trim().length === 0) {
    throw new TypeError("An explicit workspace directory is required for health checks.");
  }

  const firstWorkspace = knowledgeItems[0]?.scope.workspace;
  if (firstWorkspace !== undefined && knowledgeItems.some(({ scope }) => scope.workspace !== firstWorkspace)) {
    throw new TypeError("A health batch must contain items from one workspace scope.");
  }

  const evaluation = await evaluateKnowledgeFreshnessBatch(knowledgeItems, options, {
    maxEvidencePerKnowledge: MAX_HEALTH_EVIDENCE_DETAILS_PER_ITEM,
    missingPathReason: "source_path_missing",
  });
  return {
    checkedAt: evaluation.checkedAt,
    results: evaluation.reports.map(toKnowledgeHealth),
  };
}

/** @internal Used by the Harness adapter for fail-fast concurrent requests. */
export function makeBusyKnowledgeHealth(
  knowledge: Knowledge,
  checkedAt = new Date().toISOString(),
): KnowledgeHealth {
  const overflowCount = Math.max(0, knowledge.evidence.length - MAX_HEALTH_EVIDENCE_DETAILS_PER_ITEM);
  return {
    knowledgeId: knowledge.id,
    checkedAt,
    status: "unverifiable",
    reasons: overflowCount === 0
      ? ["health_check_busy"]
      : ["health_check_busy", "evidence_overflow"],
    evidence: knowledge.evidence.slice(0, MAX_HEALTH_EVIDENCE_DETAILS_PER_ITEM).map((item, evidenceIndex) => ({
      evidenceIndex,
      type: item.type,
      status: "unverifiable",
      reason: "health_check_busy",
    })),
    overflowCount,
  };
}

function toKnowledgeHealth(
  report: Awaited<ReturnType<typeof evaluateKnowledgeFreshnessBatch>>["reports"][number],
): KnowledgeHealth {
  const backedEvidenceIndexes = new Set<number>();
  for (const entry of report.evidence) {
    if (entry.type === "file" && entry.reason !== "missing_git_provenance") {
      backedEvidenceIndexes.add(entry.evidenceIndex);
    }
  }

  const evidence: EvidenceHealth[] = report.evidence.map((entry) => ({
    evidenceIndex: entry.evidenceIndex,
    type: entry.type,
    status: entry.status,
    reason: entry.reason ?? "snapshot_matches",
  }));

  let reasons: HealthReason[];
  if (backedEvidenceIndexes.size === 0 && report.overflowCount === 0) {
    reasons = ["no_git_backed_file_evidence"];
  } else if (report.status === "current") {
    reasons = ["snapshot_matches"];
  } else {
    const uniqueReasons = new Set<HealthReason>();
    for (const item of evidence) {
      if (backedEvidenceIndexes.has(item.evidenceIndex) && item.status !== "current") {
        uniqueReasons.add(item.reason);
      }
    }
    if (report.overflowCount > 0) {
      uniqueReasons.add("evidence_overflow");
    }
    reasons = [...uniqueReasons];
  }

  return {
    knowledgeId: report.knowledgeId,
    checkedAt: report.checkedAt,
    status: report.status,
    reasons,
    evidence,
    overflowCount: report.overflowCount,
  };
}

