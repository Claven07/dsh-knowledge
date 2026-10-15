import { renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import {
  MAX_GIT_EVIDENCE_CHECKS,
  MAX_HEALTH_BATCH_ITEMS,
  type GitCommandRunner,
  type Knowledge,
} from "../src/index.js";
import { gitTest as it, type TemporaryGitRepository } from "./git-fixtures.js";

const timestamp = "2026-10-02T10:00:00.000Z";

function knowledge(
  workspace: string,
  evidence: Knowledge["evidence"] = [],
  options: Partial<Pick<Knowledge, "status" | "creationOrigin">> = {},
): Knowledge {
  return {
    id: "health-item",
    type: "decision",
    content: "Use the policy module for authorization.",
    scope: { workspace, project: "payments" },
    status: options.status ?? "candidate",
    creationOrigin: options.creationOrigin ?? "explicit",
    evidence,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function fileEvidence(commit: string, path = "src/policy.ts") {
  return {
    type: "file" as const,
    source: path,
    timestamp,
    gitProvenance: { commit, path },
  };
}

function isEvidenceIndex(property: PropertyKey): property is `${number}` {
  return typeof property === "string" && /^(0|[1-9]\d*)$/.test(property);
}

describe("knowledge health", () => {
  it("reports a matching Git snapshot as current without implying lifecycle verification", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const item = knowledge(repository.directory, [fileEvidence(commit)], { status: "candidate" });
    const before = structuredClone(item);

    const report = await scope.health(item, { workspaceDirectory: repository.directory });

    expect(report).toMatchObject({
      knowledgeId: item.id,
      status: "current",
      reasons: ["snapshot_matches"],
      evidence: [{ evidenceIndex: 0, status: "current", reason: "snapshot_matches" }],
    });
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item).toEqual(before);
    expect(item.status).toBe("candidate");
  });

  it("distinguishes changed snapshots from paths missing in the current repository", async ({ gitScope: scope }) => {
    const repository = scope.repository("dsh-knowledge-health-changes-");

    await scope.initialize(repository.directory);
    const paths = ["committed", "staged", "unstaged", "deleted", "renamed"];
    for (const name of paths) repository.write(`src/${name}.ts`, `${name}-original\n`);
    const commit = await repository.commit("initial snapshots");

    repository.write("src/committed.ts", "committed-updated\n");
    await repository.commit("later committed change");
    repository.write("src/staged.ts", "staged-updated\n");
    await repository.git(["add", "--", "src/staged.ts"]);
    repository.write("src/unstaged.ts", "unstaged-updated\n");
    unlinkSync(join(repository.directory, "src", "deleted.ts"));
    renameSync(
      join(repository.directory, "src", "renamed.ts"),
      join(repository.directory, "src", "renamed-away.ts"),
    );

    const item = knowledge(repository.directory, paths.map((name) =>
      fileEvidence(commit, `src/${name}.ts`),
    ));
    const report = await scope.health(item, { workspaceDirectory: repository.directory });

    expect(report.status).toBe("potentially_stale");
    expect(report.evidence.map(({ status }) => status)).toEqual([
      "potentially_stale", "potentially_stale", "potentially_stale", "potentially_stale", "potentially_stale",
    ]);
    expect(report.evidence.map(({ reason }) => reason)).toEqual([
      "working_tree_changed",
      "working_tree_changed",
      "working_tree_changed",
      "source_path_missing",
      "source_path_missing",
    ]);
  }, 20_000);

  it("reports a restored snapshot as current even after an intermediate commit changed it", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    repository.write("src/policy.ts", "export const policy = 'deny';\n");
    await repository.commit("change policy");
    repository.write("src/policy.ts", "export const policy = 'allow';\n");

    const report = await scope.health(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );

    expect(report.status).toBe("current");
  });

  it("reports missing Git, repository, HEAD, and commit as unverifiable", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const noGit = scope.repository("dsh-knowledge-health-no-git-");

    const emptyRepository = scope.repository("dsh-knowledge-health-no-head-");

    await scope.initialize(emptyRepository.directory);

    const notRepository = await scope.health(
      knowledge(noGit.directory, [fileEvidence(commit)]),
      { workspaceDirectory: noGit.directory },
    );
    const noHead = await scope.health(
      knowledge(emptyRepository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: emptyRepository.directory },
    );
    const missingCommit = await scope.health(
      knowledge(repository.directory, [fileEvidence("f".repeat(40))]),
      { workspaceDirectory: repository.directory },
    );

    expect(notRepository.evidence[0]).toMatchObject({ status: "unverifiable", reason: "not_repository" });
    expect(noHead.evidence[0]).toMatchObject({ status: "unverifiable", reason: "missing_head" });
    expect(missingCommit.evidence[0]).toMatchObject({ status: "unverifiable", reason: "missing_commit" });
  });

  it.for([
    ["Git unavailable", "git_unavailable" as const],
    ["timeout", "timeout" as const],
    ["operation budget", "operation_budget_exceeded" as const],
  ] as const)("keeps %s failures unverifiable", async ([_label, failure], { gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const runner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure })),
    };

    const report = await scope.health(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory, runner },
    );

    expect(report.status).toBe("unverifiable");
    expect(report.evidence[0]).toMatchObject({ status: "unverifiable", reason: failure });
  });

  it("preserves malformed and unsafe-path results from the M3 Git layer", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const malformedRunner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "not-an-absolute-root\n" })),
    };
    const malformed = await scope.health(
      knowledge(repository.directory, [fileEvidence("a".repeat(40))]),
      { workspaceDirectory: repository.directory, runner: malformedRunner },
    );
    const unsafePath = await scope.health(
      knowledge(repository.directory, [fileEvidence("a".repeat(40), "../outside.ts")]),
      { workspaceDirectory: repository.directory },
    );

    expect(malformed.evidence[0]).toMatchObject({ status: "unverifiable", reason: "malformed_output" });
    expect(unsafePath.evidence[0]).toMatchObject({ status: "unverifiable", reason: "invalid_path" });
  });

  it("uses the existing safe-filter checks for file evidence", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    repository.write(".gitattributes", "src/policy.ts filter=untrusted-filter\n");

    const report = await scope.health(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );

    expect(report.evidence[0]).toMatchObject({ status: "unverifiable", reason: "unsafe_filter" });
  });

  it("makes session-only automatic candidates unverifiable and keeps legacy evidence valid", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const automaticCandidate = knowledge(repository.directory, [
      { type: "session", source: "session-1", locator: "seq=17", timestamp },
    ], { creationOrigin: "automatic" });
    const legacyFile = knowledge(repository.directory, [
      { type: "file", source: "src/policy.ts", timestamp },
    ]);

    const automaticHealth = await scope.health(automaticCandidate, {
      workspaceDirectory: repository.directory,
    });
    const legacyHealth = await scope.health(legacyFile, {
      workspaceDirectory: repository.directory,
    });

    expect(automaticHealth).toMatchObject({
      status: "unverifiable",
      reasons: ["no_git_backed_file_evidence"],
      evidence: [{ status: "unverifiable", reason: "not_file_evidence" }],
    });
    expect(legacyHealth).toMatchObject({
      status: "unverifiable",
      reasons: ["no_git_backed_file_evidence"],
      evidence: [{ status: "unverifiable", reason: "missing_git_provenance" }],
    });
  });

  it("reports an item with no evidence as unverifiable", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const report = await scope.health(knowledge(repository.directory), {
      workspaceDirectory: repository.directory,
    });

    expect(report).toMatchObject({
      status: "unverifiable",
      reasons: ["no_git_backed_file_evidence"],
      evidence: [],
    });
  });

  it("bounds evidence materialization and reports large overflow explicitly", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const evidenceTarget = Array.from({ length: 50_000 }, (_, index) => ({
      type: "session" as const,
      source: "session-large",
      locator: `event-${index}`,
      timestamp,
    }));
    const evidence = new Proxy(evidenceTarget, {
      get(target, property, receiver) {
        if (isEvidenceIndex(property) && Number(property) >= MAX_GIT_EVIDENCE_CHECKS) {
          throw new Error("Health evaluation accessed evidence beyond the detail limit.");
        }
        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        if (isEvidenceIndex(property) && Number(property) >= MAX_GIT_EVIDENCE_CHECKS) {
          throw new Error("Health evaluation inspected evidence beyond the detail limit.");
        }
        return Reflect.has(target, property);
      },
    });
    const item = knowledge(repository.directory, evidence);

    const report = await scope.health(item, {
      workspaceDirectory: repository.directory,
    });

    expect(report.status).toBe("unverifiable");
    expect(report.reasons).toEqual(["evidence_overflow"]);
    expect(report.evidence).toHaveLength(MAX_GIT_EVIDENCE_CHECKS);
    expect(report.overflowCount).toBe(50_000 - MAX_GIT_EVIDENCE_CHECKS);
  });

  it("keeps stale status ahead of overflow with deterministic reason ordering", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    repository.write("src/policy.ts", "export const policy = 'deny';\n");
    const evidence = [
      fileEvidence(commit),
      ...Array.from({ length: MAX_GIT_EVIDENCE_CHECKS }, (_, index) => ({
        type: "session" as const,
        source: "session-overflow",
        locator: `event-${index}`,
        timestamp,
      })),
    ];
    const item = knowledge(repository.directory, evidence);

    const first = await scope.health(item, { workspaceDirectory: repository.directory });
    const second = await scope.health(item, { workspaceDirectory: repository.directory });

    expect(first.status).toBe("potentially_stale");
    expect(first.reasons).toEqual(["working_tree_changed", "evidence_overflow"]);
    expect(first.reasons).toContain("evidence_overflow");
    expect(first.reasons).toContain("working_tree_changed");
    expect(first.reasons).toEqual(second.reasons);
    expect(first.overflowCount).toBe(1);
    expect(second.status).toBe("potentially_stale");
  });

  it("keeps session evidence informational when Git-backed evidence is current", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();

    const report = await scope.health(knowledge(repository.directory, [
      { type: "session", source: "session-1", timestamp },
      fileEvidence(commit),
    ]), { workspaceDirectory: repository.directory });

    expect(report.status).toBe("current");
    expect(report.evidence.map(({ status }) => status)).toEqual(["unverifiable", "current"]);
    expect(report.reasons).toEqual(["snapshot_matches"]);
  });

  it("uses stale-first aggregation and stable deduplicated reason ordering", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    repository.write("src/policy.ts", "changed\n");
    await repository.commit("change policy");
    unlinkSync(join(repository.directory, "src", "policy.ts"));
    const item = knowledge(repository.directory, [
      fileEvidence(commit, "src/policy.ts"),
      fileEvidence("f".repeat(40)),
      fileEvidence("f".repeat(40)),
    ]);

    const first = await scope.health(item, { workspaceDirectory: repository.directory });
    const second = await scope.health(item, { workspaceDirectory: repository.directory });

    expect(first.status).toBe("potentially_stale");
    expect(first.reasons).toEqual(["source_path_missing", "missing_commit"]);
    expect(second.reasons).toEqual(first.reasons);
  });

  it("reports empty batches deterministically without invoking Git", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const runner: GitCommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "" })) };

    const report = await scope.healthBatch([], {
      workspaceDirectory: repository.directory,
      runner,
    });

    expect(report.results).toEqual([]);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects mixed workspaces and batches above the fixed limit before Git", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const runner: GitCommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "" })) };
    const item = knowledge(repository.directory);

    await expect(scope.healthBatch([
      item,
      { ...item, id: "other", scope: { workspace: "other-workspace", project: "payments" } },
    ], { workspaceDirectory: repository.directory, runner })).rejects.toThrow(/one workspace scope/);
    await expect(scope.healthBatch(
      Array.from({ length: MAX_HEALTH_BATCH_ITEMS + 1 }, (_, index) => ({ ...item, id: `id-${index}` })),
      { workspaceDirectory: repository.directory, runner },
    )).rejects.toThrow(/at most/);
    await expect(scope.healthBatch([], { workspaceDirectory: "   ", runner }))
      .rejects.toThrow(/explicit workspace directory/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("shares the Git budget and evidence cap across the whole batch", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const failureRunner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure: "operation_budget_exceeded" as const })),
    };
    const failedBatch = await scope.healthBatch([
      knowledge(repository.directory, [fileEvidence(commit)]),
      { ...knowledge(repository.directory, [fileEvidence(commit)]), id: "second" },
    ], { workspaceDirectory: repository.directory, runner: failureRunner });
    expect(failureRunner.run).toHaveBeenCalledTimes(1);
    expect(failedBatch.results.map(({ evidence }) => evidence[0]?.reason)).toEqual([
      "operation_budget_exceeded", "operation_budget_exceeded",
    ]);

    const evidenceBatch = await scope.healthBatch([
      knowledge(repository.directory, Array.from({ length: MAX_GIT_EVIDENCE_CHECKS + 1 }, () => fileEvidence(commit))),
    ], { workspaceDirectory: repository.directory });
    expect(evidenceBatch.results[0]?.evidence).toHaveLength(MAX_GIT_EVIDENCE_CHECKS);
    expect(evidenceBatch.results[0]).toMatchObject({
      status: "unverifiable",
      reasons: ["evidence_overflow"],
      overflowCount: 1,
    });
  });

  it("deduplicates identical commit/path checks across records", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository("dsh-knowledge-health-");
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const runner = {
      run: vi.fn(async (cwd: string, args: readonly string[]) => ({
        exitCode: 0,
        stdout: await scope.git(cwd, args),
      })),
    } satisfies GitCommandRunner;
    const items = Array.from({ length: 3 }, (_, index) =>
      knowledge(repository.directory, [fileEvidence(commit)], { status: index === 0 ? "verified" : "candidate" }),
    ).map((item, index) => ({ ...item, id: `item-${index}` }));

    const report = await scope.healthBatch(items, {
      workspaceDirectory: repository.directory,
      runner,
    });

    expect(report.results.map(({ status }) => status)).toEqual(["current", "current", "current"]);
    expect(runner.run.mock.calls.filter(([, args]) => args.includes("ls-tree"))).toHaveLength(1);
    expect(runner.run.mock.calls.filter(([, args]) => args.includes("diff"))).toHaveLength(1);
  });

  it.for(["candidate", "verified", "superseded", "archived"] as const)(
    "does not mutate %s knowledge or lifecycle while checking health",
    async (status, { gitScope: scope }) => {
      const repository = await scope.newRepository("dsh-knowledge-health-");
      const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
      const item = knowledge(repository.directory, [fileEvidence(commit)], { status });
      const before = structuredClone(item);

      await scope.health(item, { workspaceDirectory: repository.directory });

      expect(item).toEqual(before);
      expect(item.status).toBe(status);
    },
  );
});

