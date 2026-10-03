import { describe, expect, expectTypeOf, it } from "vitest";
import type { HealthReason, KnowledgeHealth } from "../src/knowledge/health.js";
import {
  createHealthGuidance,
  HEALTH_GUIDANCE_CODES,
  MAX_HEALTH_GUIDANCE_ENTRIES,
  MAX_HEALTH_GUIDANCE_MESSAGE_CHARS,
  type HealthGuidanceCode,
} from "../src/harness/health-guidance.js";

const EXPECTED_MAPPING = {
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

const MIXED_REASONS: HealthReason[] = [
  "timeout", "git_unavailable", "unsafe_filter", "missing_commit",
  "working_tree_changed", "evidence_overflow",
];
const CANONICAL_CODES = [
  "inspection_incomplete", "review_claim", "review_evidence",
  "manual_safe_review", "check_environment", "retry_explicit_check",
];

describe("deterministic health guidance", () => {
  it.each(Object.entries(EXPECTED_MAPPING))("maps %s explicitly", (reason, code) => {
    const guidance = createHealthGuidance({
      status: reason === "snapshot_matches" ? "current" : "unverifiable",
      reasons: [reason as HealthReason],
    });
    expect(guidance.map((entry) => entry.code)).toEqual(code === null ? [] : [code]);
    for (const entry of guidance) {
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.message.length).toBeLessThanOrEqual(160);
    }
  });

  it("deduplicates reasons and categories without changing canonical order", () => {
    const unique = createHealthGuidance({ status: "potentially_stale", reasons: MIXED_REASONS });
    const duplicated = createHealthGuidance({
      status: "potentially_stale",
      reasons: [...MIXED_REASONS, ...MIXED_REASONS, "source_path_missing", "cancelled"],
    });
    expect(duplicated).toEqual(unique);
    expect(unique.map(({ code }) => code)).toEqual(CANONICAL_CODES);
    expect(HEALTH_GUIDANCE_CODES).toEqual(CANONICAL_CODES);
  });

  it("is independent of reason ordering and repeated calls", () => {
    const input = { status: "unverifiable" as const, reasons: MIXED_REASONS };
    const before = structuredClone(input);
    const first = createHealthGuidance(input);
    expect(createHealthGuidance({ ...input, reasons: [...input.reasons].reverse() })).toEqual(first);
    expect(createHealthGuidance(input)).toEqual(first);
    expect(input).toEqual(before);
    first[0]!.message = "caller mutation";
    expect(createHealthGuidance(input)[0]!.message).not.toBe("caller mutation");
  });

  it("bounds all categories and fixed messages at the maximum reason count", () => {
    const reasons = [...MIXED_REASONS, ...MIXED_REASONS, ...MIXED_REASONS.slice(0, 5)];
    expect(reasons).toHaveLength(17);
    const guidance = createHealthGuidance({ status: "unverifiable", reasons });
    expect(guidance).toHaveLength(6);
    expect(MAX_HEALTH_GUIDANCE_ENTRIES).toBe(6);
    expect(MAX_HEALTH_GUIDANCE_MESSAGE_CHARS).toBe(160);
    expect(guidance.every(({ message }) => message.length <= 160)).toBe(true);
  });

  it("keeps changed-source advice broad and unverifiable advice distinct from falsity", () => {
    const [changed] = createHealthGuidance({ status: "potentially_stale", reasons: ["working_tree_changed"] });
    const [missing] = createHealthGuidance({ status: "potentially_stale", reasons: ["source_path_missing"] });
    expect(changed).toEqual(missing);
    expect(changed!.message).not.toMatch(/edited|deleted|renamed|verify|archive|supersede/i);
    expect(changed!.message).toContain("may still be valid");
    expect(createHealthGuidance({ status: "unverifiable", reasons: ["no_git_backed_file_evidence"] })[0]!.message)
      .toContain("does not make the claim false");
  });

  it("accepts only status and reasons and never accesses other item metadata", () => {
    expectTypeOf<Parameters<typeof createHealthGuidance>[0]>()
      .toEqualTypeOf<Pick<KnowledgeHealth, "status" | "reasons">>();
    const input = new Proxy({ status: "unverifiable" as const, reasons: ["missing_commit" as const] }, {
      get(target, property, receiver) {
        if (property !== "status" && property !== "reasons") {
          throw new Error("Guidance read metadata outside its input contract.");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(createHealthGuidance(input).map(({ code }) => code)).toEqual(["review_evidence"]);
  });

  it.each([
    null,
    undefined,
    { status: "private-status", reasons: ["snapshot_matches"] },
    { status: "unverifiable", reasons: "C:\\private\\source.ts" },
    { status: "unverifiable", reasons: ["fatal: private stderr password=secret"] },
    { status: "current", reasons: ["a".repeat(40)] },
    { status: "unverifiable", reasons: ["__proto__"] },
    { status: "unverifiable", reasons: [null] },
    { status: "unverifiable", reasons: Array(18).fill("missing_commit") },
  ])("rejects unsupported internal input without echoing values (%#)", (input) => {
    expect(() => createHealthGuidance(input as Parameters<typeof createHealthGuidance>[0]))
      .toThrow(new TypeError("Invalid health guidance input."));
  });
});
