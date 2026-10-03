import type { HealthReason, KnowledgeHealth } from "../knowledge/health.js";

export const HEALTH_GUIDANCE_CODES = [
  "inspection_incomplete",
  "review_claim",
  "review_evidence",
  "manual_safe_review",
  "check_environment",
  "retry_explicit_check",
] as const;

export type HealthGuidanceCode = typeof HEALTH_GUIDANCE_CODES[number];

export type HealthGuidance = {
  code: HealthGuidanceCode;
  message: string;
};

export const MAX_HEALTH_GUIDANCE_ENTRIES = HEALTH_GUIDANCE_CODES.length;
export const MAX_HEALTH_GUIDANCE_MESSAGE_CHARS = 160;
// M5 reports at most 16 detail-derived reasons plus an overflow reason.
const MAX_HEALTH_GUIDANCE_REASONS = 17;

const REASON_GUIDANCE = {
  working_tree_changed: "review_claim",
  source_path_missing: "review_claim",
  invalid_path: "review_evidence",
  invalid_commit: "review_evidence",
  missing_commit: "review_evidence",
  missing_path_at_commit: "review_evidence",
  file_not_in_head: "review_evidence",
  missing_git_provenance: "review_evidence",
  not_file_evidence: "review_evidence",
  no_git_backed_file_evidence: "review_evidence",
  invalid_workspace: "check_environment",
  not_repository: "check_environment",
  git_unavailable: "check_environment",
  missing_head: "check_environment",
  command_failed: "check_environment",
  malformed_output: "check_environment",
  unsafe_path: "manual_safe_review",
  unsafe_index_state: "manual_safe_review",
  unsafe_filter: "manual_safe_review",
  health_check_busy: "retry_explicit_check",
  cancelled: "retry_explicit_check",
  timeout: "retry_explicit_check",
  evidence_overflow: "inspection_incomplete",
  operation_budget_exceeded: "inspection_incomplete",
  snapshot_matches: null,
} as const satisfies Record<HealthReason, HealthGuidanceCode | null>;

const GUIDANCE_MESSAGES: Record<HealthGuidanceCode, string> = {
  inspection_incomplete: "Inspection was incomplete. Review remaining evidence independently; inspected details do not establish full coverage.",
  review_claim: "Review the stored claim against the changed or missing source before relying on it. The claim may still be valid.",
  review_evidence: "Review the evidence references or assess the claim independently. Unverifiable evidence does not make the claim false.",
  manual_safe_review: "Review evidence in a trusted local workflow. Keep path, index, and filter safety checks enabled.",
  check_environment: "Check the active workspace and local Git availability, then request inspection again. Knowledge validity is unresolved.",
  retry_explicit_check: "Request another explicit inspection when convenient. No retry has been scheduled.",
};

/** Pure advice from bounded health reasons; it neither inspects evidence nor authorizes changes. */
export function createHealthGuidance(
  health: Pick<KnowledgeHealth, "status" | "reasons">,
): HealthGuidance[] {
  if (
    health === null || typeof health !== "object" ||
    !["current", "potentially_stale", "unverifiable"].includes(health.status) ||
    !Array.isArray(health.reasons) || health.reasons.length > MAX_HEALTH_GUIDANCE_REASONS
  ) {
    throw new TypeError("Invalid health guidance input.");
  }

  const codes = new Set<HealthGuidanceCode>();
  for (const reason of health.reasons) {
    if (typeof reason !== "string" || !Object.hasOwn(REASON_GUIDANCE, reason)) {
      throw new TypeError("Invalid health guidance input.");
    }
    const code = REASON_GUIDANCE[reason];
    if (code !== null) {
      codes.add(code);
    }
  }
  if (health.status === "current") {
    return [];
  }

  return HEALTH_GUIDANCE_CODES
    .filter((code) => codes.has(code))
    .map((code) => ({ code, message: GUIDANCE_MESSAGES[code] }));
}
