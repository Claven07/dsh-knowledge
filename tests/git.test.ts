import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, expectTypeOf, vi } from "vitest";
import type {
  FileProvenanceCapture,
  FileSnapshotComparison,
  FreshnessReason,
  GitOperationReason,
} from "../src/index.js";
import {
  normalizeGitCommit,
  normalizeRepositoryRelativePath,
  type GitCommandRunner,
} from "../src/knowledge/git.js";
import type { Knowledge } from "../src/knowledge/types.js";
import { gitTest as it, type TemporaryGitRepository } from "./git-fixtures.js";

function knowledge(
  workspaceDirectory: string,
  evidence: Knowledge["evidence"],
  status: Knowledge["status"] = "candidate",
): Knowledge {
  const timestamp = "2026-10-02T10:00:00.000Z";
  return {
    id: "knowledge-1",
    type: "decision",
    content: "Use the policy module for authorization.",
    scope: { workspace: workspaceDirectory, project: "payments" },
    status,
    creationOrigin: "explicit",
    evidence,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function fileEvidence(commit: string, path = "src/policy.ts") {
  return {
    type: "file" as const,
    source: path,
    timestamp: "2026-10-02T10:00:00.000Z",
    gitProvenance: { commit, path },
  };
}

describe("Git path and commit validation", () => {
  it.each([
    ["src\\auth\\policy.ts", "src/auth/policy.ts"],
    ["./src//auth/policy.ts", "src/auth/policy.ts"],
    ["file with spaces.ts", "file with spaces.ts"],
    ["src/literal*[x]?.ts", "src/literal*[x]?.ts"],
    ["src/你好.ts", "src/你好.ts"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRepositoryRelativePath(input)).toBe(expected);
  });

  it.each(["", "/etc/passwd", "C:\\private\\key", "\\\\server\\share", "../secret", "src/../../secret", "src\0x"])(
    "rejects unsafe path %s",
    (input) => expect(() => normalizeRepositoryRelativePath(input)).toThrow(),
  );

  it("accepts full SHA-1 and SHA-256 object IDs and canonicalizes case", () => {
    expect(normalizeGitCommit("A".repeat(40))).toBe("a".repeat(40));
    expect(normalizeGitCommit("B".repeat(64))).toBe("b".repeat(64));
    expect(() => normalizeGitCommit("abc123")).toThrow(/full SHA-1 or SHA-256/);
  });
});

describe("Git provenance capture", () => {
  it("captures a clean committed file and normalizes Windows separators", async ({ gitScope: scope }) => {
    const repository = scope.repository();

    await scope.initialize(repository.directory);
    repository.write("src/file with spaces.ts", "export const ok = true;\n");
    const commit = await repository.commit();

    const result = await scope.capture({
      workspaceDirectory: repository.directory,
      filePath: "src\\file with spaces.ts",
    });
    expect(result).toEqual({
      status: "captured",
      provenance: { commit, path: "src/file with spaces.ts" },
    });
    const stateAfter = await repository.git(["status", "--porcelain=v1", "-z"]);
    expect(stateAfter).toBe("");
  });

  it("discovers the repository root when the session starts in a nested project directory", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    mkdirSync(join(repository.directory, "packages", "app"), { recursive: true });
    const result = await scope.capture({
      workspaceDirectory: join(repository.directory, "packages", "app"),
      filePath: "src/policy.ts",
    });
    expect(result).toMatchObject({
      status: "captured",
      provenance: { path: "src/policy.ts" },
    });
  });

  it("uses the nearest repository for a nested Git worktree", async ({ gitScope: scope }) => {
    const outer = await scope.newRepository();
    const nestedPath = join(outer.directory, "vendor", "nested");
    mkdirSync(nestedPath, { recursive: true });
    await scope.initialize(nestedPath);
    writeFileSync(join(nestedPath, "nested-policy.ts"), "export const nested = true;\n", "utf8");
    await scope.git(nestedPath, ["add", "--all"]);
    await scope.git(nestedPath, ["commit", "--quiet", "-m", "nested policy"]);
    const nestedCommit = (await scope.git(nestedPath, ["rev-parse", "HEAD"])).trim();

    const result = await scope.capture({
      workspaceDirectory: nestedPath,
      filePath: "nested-policy.ts",
    });
    expect(result).toEqual({
      status: "captured",
      provenance: { commit: nestedCommit, path: "nested-policy.ts" },
    });
  });

  it.for([
    ["working-tree dirty", "src/policy.ts", async (repo: TemporaryGitRepository) => {
      repo.write("src/policy.ts", "dirty worktree\n");
    }, "working_tree_changed"],
    ["staged", "src/policy.ts", async (repo: TemporaryGitRepository) => {
      repo.write("src/policy.ts", "staged change\n");
      await repo.git(["add", "--", "src/policy.ts"]);
    }, "working_tree_changed"],
    ["untracked", "src/untracked.ts", async (repo: TemporaryGitRepository) => {
      repo.write("src/untracked.ts", "not committed\n");
    }, "file_not_in_head"],
    ["deleted", "src/policy.ts", async (repo: TemporaryGitRepository) => {
      unlinkSync(join(repo.directory, "src", "policy.ts"));
    }, "working_tree_changed"],
  ] as const)("does not capture a %s file", async ([_name, filePath, change, reason], { gitScope: scope }) => {
    const repository = await scope.newRepository();
    await change(repository);
    const result = await scope.capture({
      workspaceDirectory: repository.directory,
      filePath,
    });
    expect(result).toEqual({ status: "skipped", reason });
  });

  it.for(["--assume-unchanged", "--skip-worktree"] as const)(
    "refuses provenance when the index hides worktree state with %s",
    async (flag, { gitScope: scope }) => {
      const repository = await scope.newRepository();
      repository.write("src/policy.ts", "hidden dirty state\n");
      await repository.git(["update-index", flag, "--", "src/policy.ts"]);

      await expect(scope.capture({
        workspaceDirectory: repository.directory,
        filePath: "src/policy.ts",
      })).resolves.toEqual({ status: "skipped", reason: "unsafe_index_state" });

      const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
      const report = await scope.freshness(
        knowledge(repository.directory, [fileEvidence(commit)]),
        { workspaceDirectory: repository.directory },
      );
      expect(report).toMatchObject({
        status: "unverifiable",
        evidence: [{ status: "unverifiable", reason: "unsafe_index_state" }],
      });
    },
  );

  it("does not follow a symlinked parent outside the repository", async ({ gitScope: scope, skip }) => {
    const repository = await scope.newRepository();
    const externalDirectory = mkdtempSync(join(tmpdir(), "dsh-knowledge-external-"));
    scope.directory(externalDirectory);
    writeFileSync(join(externalDirectory, "policy.ts"), "export const policy = 'allow';\n", "utf8");
    rmSync(join(repository.directory, "src"), { recursive: true, force: true });
    try {
      symlinkSync(externalDirectory, join(repository.directory, "src"), "junction");
    } catch {
      skip("This host does not permit temporary directory symlinks.");
    }

    const captured = await scope.capture({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
    });
    expect(captured).toEqual({ status: "skipped", reason: "unsafe_path" });

    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report).toMatchObject({
      status: "unverifiable",
      evidence: [{ status: "unverifiable", reason: "unsafe_path" }],
    });
  });

  it("rejects absolute outside-repository and traversal paths without invoking Git", async ({ gitScope: scope }) => {
    const runner: GitCommandRunner = { run: vi.fn() };
    for (const filePath of ["../outside.ts", "C:\\private\\file.ts", "/private/file.ts"]) {
      const result = await scope.capture({
        workspaceDirectory: "C:\\workspace",
        filePath,
        runner,
      });
      expect(result).toEqual({ status: "skipped", reason: "invalid_path" });
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns safe skip reasons for missing Git, invalid repositories, and repositories without HEAD", async ({ gitScope: scope }) => {
    const emptyWorkspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-no-git-"));
    scope.directory(emptyWorkspace);
    const missingGit: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure: "git_unavailable" as const })),
    };
    expect(await scope.capture({
      workspaceDirectory: emptyWorkspace,
      filePath: "src/policy.ts",
      runner: missingGit,
    })).toEqual({ status: "skipped", reason: "git_unavailable" });

    const commandFailure: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: 128, stdout: "" })),
    };
    expect(await scope.capture({
      workspaceDirectory: emptyWorkspace,
      filePath: "src/policy.ts",
      runner: commandFailure,
    })).toEqual({ status: "skipped", reason: "not_repository" });

    const nonRepository = scope.repository("dsh-knowledge-not-git-");

    expect(await scope.capture({
      workspaceDirectory: nonRepository.directory,
      filePath: "src/policy.ts",
    })).toEqual({ status: "skipped", reason: "not_repository" });

    const emptyRepository = scope.repository("dsh-knowledge-no-head-");

    await scope.initialize(emptyRepository.directory);
    expect(await scope.capture({
      workspaceDirectory: emptyRepository.directory,
      filePath: "src/policy.ts",
    })).toEqual({ status: "skipped", reason: "missing_head" });
  });

  it("ignores inherited Git trace settings that could write outside the repository", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const traceFile = join(repository.directory, "git-trace.log");
    const previousTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    try {
      const result = await scope.capture({
        workspaceDirectory: repository.directory,
        filePath: "src/policy.ts",
      });
      expect(result.status).toBe("captured");
      expect(existsSync(traceFile)).toBe(false);
    } finally {
      if (previousTrace === undefined) {
        delete process.env.GIT_TRACE;
      } else {
        process.env.GIT_TRACE = previousTrace;
      }
      if (existsSync(traceFile)) {
        unlinkSync(traceFile);
      }
    }
  });

  it("propagates unexpected injected runner errors instead of disguising them as Git failures", async ({ gitScope: scope }) => {
    const workspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-runner-error-"));
    scope.directory(workspace);
    const runner: GitCommandRunner = {
      run: vi.fn(async () => { throw new Error("runner programming error"); }),
    };
    await expect(scope.capture({
      workspaceDirectory: workspace,
      filePath: "src/policy.ts",
      runner,
    })).rejects.toThrow("runner programming error");
  });

  it("supports detached HEAD and shallow repositories without network access", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    await repository.git(["checkout", "--quiet", "--detach", "HEAD"]);
    const detached = await scope.capture({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
    });
    expect(detached.status).toBe("captured");

    const cloneParent = mkdtempSync(join(tmpdir(), "dsh-knowledge-shallow-"));
    scope.directory(cloneParent);
    const shallowPath = join(cloneParent, "shallow");
    await scope.git(cloneParent, ["clone", "--quiet", "--depth", "1", pathToFileURL(repository.directory).href, shallowPath]);
    expect((await scope.git(shallowPath, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true");
    const shallow = await scope.capture({
      workspaceDirectory: shallowPath,
      filePath: "src/policy.ts",
    });
    expect(shallow.status).toBe("captured");
  }, 20_000);

  it("returns unverifiable for configured filters and Git execution timeouts", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    repository.write(".gitattributes", "src/policy.ts filter=untrusted-filter\n");
    const filtered = await scope.capture({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
    });
    expect(filtered).toEqual({ status: "skipped", reason: "unsafe_filter" });

    const timeoutRunner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure: "timeout" as const })),
    };
    expect(await scope.capture({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
      runner: timeoutRunner,
    })).toEqual({ status: "skipped", reason: "timeout" });
  });

  it("passes literal wildcard paths as arguments after --", async ({ gitScope: scope }) => {
    const wildcardPath = "src/literal*[x]?.ts";
    const commit = "a".repeat(40);
    const workspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-wildcard-path-"));
    scope.directory(workspace);
    const runner: GitCommandRunner = {
      run: vi.fn(async (_cwd, args) => {
        if (args.includes("--show-toplevel")) return { exitCode: 0, stdout: `${workspace}\n` };
        if (args.includes("HEAD^{commit}")) return { exitCode: 0, stdout: `${commit}\n` };
        if (args.includes("check-attr")) {
          const path = args[args.lastIndexOf("--") + 1]!;
          return { exitCode: 0, stdout: `${path}\0filter\0unspecified\0` };
        }
        if (args.includes("ls-files")) {
          const path = args[args.lastIndexOf("--") + 1]!;
          return { exitCode: 0, stdout: `H ${path}\0` };
        }
        if (args.includes("ls-tree")) {
          const path = args[args.lastIndexOf("--") + 1]!;
          return { exitCode: 0, stdout: `100644 blob ${"b".repeat(40)}\t${path}\0` };
        }
        if (args.includes("diff")) return { exitCode: 0, stdout: "" };
        return { exitCode: 1, stdout: "" };
      }),
    };
    const result = await scope.capture({
      workspaceDirectory: workspace,
      filePath: wildcardPath,
      runner,
    });
    // This platform-neutral fixture cannot create a filename containing `*`
    // and `?` on Windows, but Git still receives the path literally after `--`.
    expect(result).toEqual({ status: "skipped", reason: "working_tree_changed" });
    const commands = (runner.run as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, args] of commands) {
      const separator = args.indexOf("--");
      if (separator >= 0 && args.includes(wildcardPath)) {
        expect(args[separator + 1]).toBe(wildcardPath);
      }
    }
    expect(commands[0]?.[1]).toContain("--literal-pathspecs");
  });
});

describe("Git-backed freshness", () => {
  it("keeps the M5 missing-path reason out of existing public M3 result types", () => {
    expectTypeOf<Extract<GitOperationReason, "source_path_missing">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<NonNullable<FileSnapshotComparison["reason"]>, "source_path_missing">>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<FreshnessReason, "source_path_missing">>().toEqualTypeOf<never>();
    type CaptureSkippedReason = Extract<FileProvenanceCapture, { status: "skipped" }>["reason"];
    expectTypeOf<Extract<CaptureSkippedReason, "source_path_missing">>().toEqualTypeOf<never>();
  });

  it("marks an unchanged snapshot current", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report.status).toBe("current");
    expect(report.evidence[0]?.status).toBe("current");
  });

  it.for([
    ["modified", async (repo: TemporaryGitRepository) => {
      repo.write("src/policy.ts", "export const policy = 'deny';\n");
      await repo.commit("modify policy");
    }],
    ["deleted", async (repo: TemporaryGitRepository) => {
      unlinkSync(join(repo.directory, "src", "policy.ts"));
      await repo.git(["add", "--all"]);
      await repo.git(["commit", "--quiet", "-m", "delete policy"]);
    }],
    ["renamed", async (repo: TemporaryGitRepository) => {
      renameSync(join(repo.directory, "src", "policy.ts"), join(repo.directory, "src", "authorization.ts"));
      await repo.git(["add", "--all"]);
      await repo.git(["commit", "--quiet", "-m", "rename policy"]);
    }],
    ["dirty", async (repo: TemporaryGitRepository) => {
      repo.write("src/policy.ts", "dirty working tree\n");
    }],
  ] as const)("marks a %s snapshot potentially stale", async ([_name, change], { gitScope: scope }) => {
    const repository = await scope.newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    await change(repository);
    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report.status).toBe("potentially_stale");
    expect(report.evidence[0]?.status).toBe("potentially_stale");
  });

  it("preserves the M3 changed-path reason without resolving a rename", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    renameSync(
      join(repository.directory, "src", "policy.ts"),
      join(repository.directory, "src", "authorization.ts"),
    );

    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );

    expect(report.status).toBe("potentially_stale");
    expect(report.evidence[0]).toMatchObject({
      status: "potentially_stale",
      reason: "working_tree_changed",
    });
  });

  it("keeps a missing path compatible for M3 APIs while M5 reports the specific condition", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const evidence = fileEvidence(commit);
    unlinkSync(join(repository.directory, "src", "policy.ts"));

    const comparison = await scope.compare({
      workspaceDirectory: repository.directory,
      provenances: [evidence.gitProvenance],
    });
    const m3 = await scope.freshness(
      knowledge(repository.directory, [evidence]),
      { workspaceDirectory: repository.directory },
    );
    const m5 = await scope.health(
      knowledge(repository.directory, [evidence]),
      { workspaceDirectory: repository.directory },
    );

    expect(comparison[0]).toMatchObject({
      status: "potentially_stale",
      reason: "working_tree_changed",
    });
    expect(m3.evidence[0]).toMatchObject({
      status: "potentially_stale",
      reason: "working_tree_changed",
    });
    expect(m5.evidence[0]).toMatchObject({
      status: "potentially_stale",
      reason: "source_path_missing",
    });
  });

  it("reports a retained file removed from the index as changed rather than missing", async ({ gitScope: scope }) => {
    const repository = scope.repository();

    await scope.initialize(repository.directory);
    const path = "policy.ts";
    const content = "export const policy = 'allow';\n";
    repository.write(path, content);
    const commit = await repository.commit("initial policy");
    const capture = await scope.capture({
      workspaceDirectory: repository.directory,
      filePath: path,
    });
    expect(capture).toEqual({ status: "captured", provenance: { commit, path } });
    if (capture.status !== "captured") throw new Error("Fixture provenance was not captured.");

    await repository.git(["rm", "--cached", "--", path]);
    expect(readFileSync(join(repository.directory, path), "utf8")).toBe(content);
    expect(await repository.git(["ls-files", "--", path])).toBe("");

    const evidence = fileEvidence(capture.provenance.commit, capture.provenance.path);
    const item = knowledge(repository.directory, [evidence]);
    const comparison = await scope.compare({
      workspaceDirectory: repository.directory,
      provenances: [capture.provenance],
    });
    const freshness = await scope.freshness(item, { workspaceDirectory: repository.directory });
    const health = await scope.health(item, { workspaceDirectory: repository.directory });

    expect(comparison[0]).toEqual({ status: "potentially_stale", reason: "working_tree_changed" });
    for (const report of [freshness, health]) {
      expect(report.status).toBe("potentially_stale");
      expect(report.evidence[0]).toMatchObject({
        status: "potentially_stale",
        reason: "working_tree_changed",
      });
    }
    expect(health.reasons).toEqual(["working_tree_changed"]);

    unlinkSync(join(repository.directory, path));
    const deletedHealth = await scope.health(item, { workspaceDirectory: repository.directory });
    expect(deletedHealth.status).toBe("potentially_stale");
    expect(deletedHealth.evidence[0]?.reason).toBe("source_path_missing");
    expect(deletedHealth.reasons).toEqual(["source_path_missing"]);
  }, 20_000);

  it("marks an exactly restored source snapshot current", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    repository.write("src/policy.ts", "export const policy = 'deny';\n");
    await repository.commit("change policy");
    repository.write("src/policy.ts", "export const policy = 'allow';\n");

    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report.status).toBe("current");
  });

  it("returns unverifiable for missing commits, legacy evidence, and session evidence", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const missing = await scope.freshness(
      knowledge(repository.directory, [fileEvidence("f".repeat(40))]),
      { workspaceDirectory: repository.directory },
    );
    expect(missing.evidence[0]).toMatchObject({ status: "unverifiable", reason: "missing_commit" });

    const legacy = await scope.freshness(knowledge(repository.directory, [
      { type: "file", source: "src/policy.ts", timestamp: "2026-10-02T10:00:00.000Z" },
    ]), { workspaceDirectory: repository.directory });
    expect(legacy).toMatchObject({ status: "unverifiable", evidence: [{ status: "unverifiable", reason: "missing_git_provenance" }] });

    const sessionOnly = await scope.freshness(knowledge(repository.directory, [
      { type: "session", source: "session-1", timestamp: "2026-10-02T10:00:00.000Z" },
    ]), { workspaceDirectory: repository.directory });
    expect(sessionOnly.status).toBe("unverifiable");
    expect(sessionOnly.evidence[0]?.reason).toBe("not_file_evidence");
  });

  it.for([
    ["missing Git", "git_unavailable" as const],
    ["timeout", "timeout" as const],
  ] as const)("reports %s as unverifiable", async ([_name, failure], { gitScope: scope }) => {
    const repository = await scope.newRepository();
    const runner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure })),
    };
    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence("a".repeat(40))]),
      { workspaceDirectory: repository.directory, runner },
    );
    expect(report.status).toBe("unverifiable");
    expect(report.evidence[0]?.status).toBe("unverifiable");
  });

  it("propagates caller cancellation through the Git runner", async ({ gitScope: scope }) => {
    const repository = await scope.newRepository();
    const controller = new AbortController();
    const cancellationSignal = scope.signalFor(controller.signal);
    const runner: GitCommandRunner = {
      run: vi.fn(async (_cwd, _args, _timeout, signal) => {
        expect(signal).toBe(cancellationSignal);
        return { exitCode: null, stdout: "", failure: "cancelled" as const };
      }),
    };

    const report = await scope.freshness(
      knowledge(repository.directory, [fileEvidence("a".repeat(40))]),
      { workspaceDirectory: repository.directory, runner, signal: controller.signal },
    );

    expect(report.status).toBe("unverifiable");
    expect(report.evidence[0]).toMatchObject({ status: "unverifiable", reason: "cancelled" });
  });

  it("handles malformed Git output and bounds evidence checks", async ({ gitScope: scope }) => {
    const validRepository = await scope.newRepository();
    await expect(scope.compare({
      workspaceDirectory: validRepository.directory,
      provenances: [{ commit: "not-a-full-object-id", path: "src/policy.ts" }],
    })).resolves.toEqual([{ status: "unverifiable", reason: "invalid_commit" }]);

    const malformedRunner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "not-an-absolute-root\n" })),
    };
    const malformed = await scope.freshness(
      knowledge(validRepository.directory, [fileEvidence("a".repeat(40))]),
      { workspaceDirectory: validRepository.directory, runner: malformedRunner },
    );
    expect(malformed.evidence[0]).toMatchObject({ status: "unverifiable", reason: "malformed_output" });

    const repository = validRepository;
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const evidence = Array.from({ length: 18 }, (_, index) => fileEvidence(commit, `src/policy-${index}.ts`));
    const report = await scope.freshness(
      knowledge(repository.directory, evidence),
      { workspaceDirectory: repository.directory },
    );
    expect(report.evidence.slice(16).every(({ status }) => status === "unverifiable")).toBe(true);
  });

  it.for(["candidate", "verified", "superseded", "archived"] as const)(
    "does not change the %s lifecycle state",
    async (status, { gitScope: scope }) => {
      // Native Git snapshot comparisons are covered by the integration cases above.
      const workspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-lifecycle-"));
      scope.directory(workspace);
      mkdirSync(join(workspace, "src"));
      writeFileSync(join(workspace, "src/policy.ts"), "export const policy = 'allow';\n");
      const commit = "a".repeat(40);
      const runner: GitCommandRunner = {
        run: vi.fn(async (_cwd, args) => {
          if (args.includes("rev-parse")) {
            return { exitCode: 0, stdout: `${args.includes("--show-toplevel") ? workspace : commit}\n` };
          }
          if (args.includes("ls-files")) return { exitCode: 0, stdout: "H src/policy.ts\0" };
          if (args.includes("check-attr")) {
            return { exitCode: 0, stdout: "src/policy.ts\0filter\0unspecified\0" };
          }
          if (args.includes("ls-tree")) {
            return { exitCode: 0, stdout: `100644 blob ${"b".repeat(40)}\tsrc/policy.ts\0` };
          }
          if (args.includes("diff")) return { exitCode: 0, stdout: "" };
          throw new Error("Unexpected Git command in lifecycle fixture");
        }),
      };
      const item = knowledge(workspace, [fileEvidence(commit)], status);
      const report = await scope.freshness(item, { workspaceDirectory: workspace, runner });
      expect(report.status).toBe("current");
      expect(item.status).toBe(status);
    },
  );

  it("aggregates multiple evidence records and keeps their individual states", async ({ gitScope: scope }) => {
    const repository = scope.repository();

    await scope.initialize(repository.directory);
    repository.write("src/current.ts", "current\n");
    repository.write("src/changed.ts", "original\n");
    const commit = await repository.commit();
    repository.write("src/changed.ts", "changed\n");

    const report = await scope.freshness(knowledge(repository.directory, [
      fileEvidence(commit, "src/current.ts"),
      fileEvidence(commit, "src/changed.ts"),
      { type: "session", source: "session-1", timestamp: "2026-10-02T10:00:00.000Z" },
    ]), { workspaceDirectory: repository.directory });
    expect(report.status).toBe("potentially_stale");
    expect(report.evidence.map(({ status }) => status)).toEqual([
      "current", "potentially_stale", "unverifiable",
    ]);
  });
});
