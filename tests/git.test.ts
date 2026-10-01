import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureFileProvenance,
  compareFileSnapshots,
  normalizeGitCommit,
  normalizeRepositoryRelativePath,
  type GitCommandRunner,
} from "../src/knowledge/git.js";
import { checkKnowledgeFreshness } from "../src/knowledge/freshness.js";
import type { Knowledge } from "../src/knowledge/types.js";
import { createTemporaryGitRepository, initializeGitRepository, runGit } from "./git-fixtures.js";

const repositories: Array<{ cleanup(): void }> = [];
const directories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function newRepository(): Promise<ReturnType<typeof createTemporaryGitRepository>> {
  const repository = createTemporaryGitRepository();
  repositories.push(repository);
  await initializeGitRepository(repository.directory);
  repository.write("src/policy.ts", "export const policy = 'allow';\n");
  await repository.commit("initial");
  return repository;
}

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
  it("captures a clean committed file and normalizes Windows separators", async () => {
    const repository = createTemporaryGitRepository();
    repositories.push(repository);
    await initializeGitRepository(repository.directory);
    repository.write("src/file with spaces.ts", "export const ok = true;\n");
    const commit = await repository.commit();

    const result = await captureFileProvenance({
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

  it("discovers the repository root when the session starts in a nested project directory", async () => {
    const repository = await newRepository();
    mkdirSync(join(repository.directory, "packages", "app"), { recursive: true });
    const result = await captureFileProvenance({
      workspaceDirectory: join(repository.directory, "packages", "app"),
      filePath: "src/policy.ts",
    });
    expect(result).toMatchObject({
      status: "captured",
      provenance: { path: "src/policy.ts" },
    });
  });

  it("uses the nearest repository for a nested Git worktree", async () => {
    const outer = await newRepository();
    const nestedPath = join(outer.directory, "vendor", "nested");
    mkdirSync(nestedPath, { recursive: true });
    await initializeGitRepository(nestedPath);
    writeFileSync(join(nestedPath, "nested-policy.ts"), "export const nested = true;\n", "utf8");
    await runGit(nestedPath, ["add", "--all"]);
    await runGit(nestedPath, ["commit", "--quiet", "-m", "nested policy"]);
    const nestedCommit = (await runGit(nestedPath, ["rev-parse", "HEAD"])).trim();

    const result = await captureFileProvenance({
      workspaceDirectory: nestedPath,
      filePath: "nested-policy.ts",
    });
    expect(result).toEqual({
      status: "captured",
      provenance: { commit: nestedCommit, path: "nested-policy.ts" },
    });
  });

  it.each([
    ["working-tree dirty", "src/policy.ts", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      repo.write("src/policy.ts", "dirty worktree\n");
    }, "working_tree_changed"],
    ["staged", "src/policy.ts", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      repo.write("src/policy.ts", "staged change\n");
      await repo.git(["add", "--", "src/policy.ts"]);
    }, "working_tree_changed"],
    ["untracked", "src/untracked.ts", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      repo.write("src/untracked.ts", "not committed\n");
    }, "file_not_in_head"],
    ["deleted", "src/policy.ts", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      unlinkSync(join(repo.directory, "src", "policy.ts"));
    }, "working_tree_changed"],
  ] as const)("does not capture a %s file", async (_name, filePath, change, reason) => {
    const repository = await newRepository();
    await change(repository);
    const result = await captureFileProvenance({
      workspaceDirectory: repository.directory,
      filePath,
    });
    expect(result).toEqual({ status: "skipped", reason });
  });

  it.each(["--assume-unchanged", "--skip-worktree"] as const)(
    "refuses provenance when the index hides worktree state with %s",
    async (flag) => {
      const repository = await newRepository();
      repository.write("src/policy.ts", "hidden dirty state\n");
      await repository.git(["update-index", flag, "--", "src/policy.ts"]);

      await expect(captureFileProvenance({
        workspaceDirectory: repository.directory,
        filePath: "src/policy.ts",
      })).resolves.toEqual({ status: "skipped", reason: "unsafe_index_state" });

      const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
      const report = await checkKnowledgeFreshness(
        knowledge(repository.directory, [fileEvidence(commit)]),
        { workspaceDirectory: repository.directory },
      );
      expect(report).toMatchObject({
        status: "unverifiable",
        evidence: [{ status: "unverifiable", reason: "unsafe_index_state" }],
      });
    },
  );

  it("does not follow a symlinked parent outside the repository", async (context) => {
    const repository = await newRepository();
    const externalDirectory = mkdtempSync(join(tmpdir(), "dsh-knowledge-external-"));
    directories.push(externalDirectory);
    writeFileSync(join(externalDirectory, "policy.ts"), "export const policy = 'allow';\n", "utf8");
    rmSync(join(repository.directory, "src"), { recursive: true, force: true });
    try {
      symlinkSync(externalDirectory, join(repository.directory, "src"), "junction");
    } catch {
      context.skip("This host does not permit temporary directory symlinks.");
    }

    const captured = await captureFileProvenance({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
    });
    expect(captured).toEqual({ status: "skipped", reason: "unsafe_path" });

    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const report = await checkKnowledgeFreshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report).toMatchObject({
      status: "unverifiable",
      evidence: [{ status: "unverifiable", reason: "unsafe_path" }],
    });
  });

  it("rejects absolute outside-repository and traversal paths without invoking Git", async () => {
    const runner: GitCommandRunner = { run: vi.fn() };
    for (const filePath of ["../outside.ts", "C:\\private\\file.ts", "/private/file.ts"]) {
      const result = await captureFileProvenance({
        workspaceDirectory: "C:\\workspace",
        filePath,
        runner,
      });
      expect(result).toEqual({ status: "skipped", reason: "invalid_path" });
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns safe skip reasons for missing Git, invalid repositories, and repositories without HEAD", async () => {
    const emptyWorkspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-no-git-"));
    directories.push(emptyWorkspace);
    const missingGit: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure: "git_unavailable" as const })),
    };
    expect(await captureFileProvenance({
      workspaceDirectory: emptyWorkspace,
      filePath: "src/policy.ts",
      runner: missingGit,
    })).toEqual({ status: "skipped", reason: "git_unavailable" });

    const commandFailure: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: 128, stdout: "" })),
    };
    expect(await captureFileProvenance({
      workspaceDirectory: emptyWorkspace,
      filePath: "src/policy.ts",
      runner: commandFailure,
    })).toEqual({ status: "skipped", reason: "not_repository" });

    const nonRepository = createTemporaryGitRepository("dsh-knowledge-not-git-");
    repositories.push(nonRepository);
    expect(await captureFileProvenance({
      workspaceDirectory: nonRepository.directory,
      filePath: "src/policy.ts",
    })).toEqual({ status: "skipped", reason: "not_repository" });

    const emptyRepository = createTemporaryGitRepository("dsh-knowledge-no-head-");
    repositories.push(emptyRepository);
    await initializeGitRepository(emptyRepository.directory);
    expect(await captureFileProvenance({
      workspaceDirectory: emptyRepository.directory,
      filePath: "src/policy.ts",
    })).toEqual({ status: "skipped", reason: "missing_head" });
  });

  it("ignores inherited Git trace settings that could write outside the repository", async () => {
    const repository = await newRepository();
    const traceFile = join(repository.directory, "git-trace.log");
    const previousTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    try {
      const result = await captureFileProvenance({
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

  it("propagates unexpected injected runner errors instead of disguising them as Git failures", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-runner-error-"));
    directories.push(workspace);
    const runner: GitCommandRunner = {
      run: vi.fn(async () => { throw new Error("runner programming error"); }),
    };
    await expect(captureFileProvenance({
      workspaceDirectory: workspace,
      filePath: "src/policy.ts",
      runner,
    })).rejects.toThrow("runner programming error");
  });

  it("supports detached HEAD and shallow repositories without network access", async () => {
    const repository = await newRepository();
    await repository.git(["checkout", "--quiet", "--detach", "HEAD"]);
    const detached = await captureFileProvenance({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
    });
    expect(detached.status).toBe("captured");

    const cloneParent = mkdtempSync(join(tmpdir(), "dsh-knowledge-shallow-"));
    directories.push(cloneParent);
    const shallowPath = join(cloneParent, "shallow");
    await runGit(cloneParent, ["clone", "--quiet", "--depth", "1", pathToFileURL(repository.directory).href, shallowPath]);
    expect((await runGit(shallowPath, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true");
    const shallow = await captureFileProvenance({
      workspaceDirectory: shallowPath,
      filePath: "src/policy.ts",
    });
    expect(shallow.status).toBe("captured");
  }, 20_000);

  it("returns unverifiable for configured filters and Git execution timeouts", async () => {
    const repository = await newRepository();
    repository.write(".gitattributes", "src/policy.ts filter=untrusted-filter\n");
    const filtered = await captureFileProvenance({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
    });
    expect(filtered).toEqual({ status: "skipped", reason: "unsafe_filter" });

    const timeoutRunner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure: "timeout" as const })),
    };
    expect(await captureFileProvenance({
      workspaceDirectory: repository.directory,
      filePath: "src/policy.ts",
      runner: timeoutRunner,
    })).toEqual({ status: "skipped", reason: "timeout" });
  });

  it("passes literal wildcard paths as arguments after --", async () => {
    const wildcardPath = "src/literal*[x]?.ts";
    const commit = "a".repeat(40);
    const workspace = mkdtempSync(join(tmpdir(), "dsh-knowledge-wildcard-path-"));
    directories.push(workspace);
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
    const result = await captureFileProvenance({
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
  it("marks an unchanged snapshot current", async () => {
    const repository = await newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const report = await checkKnowledgeFreshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report.status).toBe("current");
    expect(report.evidence[0]?.status).toBe("current");
  });

  it.each([
    ["modified", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      repo.write("src/policy.ts", "export const policy = 'deny';\n");
      await repo.commit("modify policy");
    }],
    ["deleted", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      unlinkSync(join(repo.directory, "src", "policy.ts"));
      await repo.git(["add", "--all"]);
      await repo.git(["commit", "--quiet", "-m", "delete policy"]);
    }],
    ["renamed", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      renameSync(join(repo.directory, "src", "policy.ts"), join(repo.directory, "src", "authorization.ts"));
      await repo.git(["add", "--all"]);
      await repo.git(["commit", "--quiet", "-m", "rename policy"]);
    }],
    ["dirty", async (repo: Awaited<ReturnType<typeof newRepository>>) => {
      repo.write("src/policy.ts", "dirty working tree\n");
    }],
  ] as const)("marks a %s snapshot potentially stale", async (_name, change) => {
    const repository = await newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    await change(repository);
    const report = await checkKnowledgeFreshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report.status).toBe("potentially_stale");
    expect(report.evidence[0]?.status).toBe("potentially_stale");
  });

  it("marks an exactly restored source snapshot current", async () => {
    const repository = await newRepository();
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    repository.write("src/policy.ts", "export const policy = 'deny';\n");
    await repository.commit("change policy");
    repository.write("src/policy.ts", "export const policy = 'allow';\n");

    const report = await checkKnowledgeFreshness(
      knowledge(repository.directory, [fileEvidence(commit)]),
      { workspaceDirectory: repository.directory },
    );
    expect(report.status).toBe("current");
  });

  it("returns unverifiable for missing commits, legacy evidence, and session evidence", async () => {
    const repository = await newRepository();
    const missing = await checkKnowledgeFreshness(
      knowledge(repository.directory, [fileEvidence("f".repeat(40))]),
      { workspaceDirectory: repository.directory },
    );
    expect(missing.evidence[0]).toMatchObject({ status: "unverifiable", reason: "missing_commit" });

    const legacy = await checkKnowledgeFreshness(knowledge(repository.directory, [
      { type: "file", source: "src/policy.ts", timestamp: "2026-10-02T10:00:00.000Z" },
    ]), { workspaceDirectory: repository.directory });
    expect(legacy).toMatchObject({ status: "unverifiable", evidence: [{ status: "unverifiable", reason: "missing_git_provenance" }] });

    const sessionOnly = await checkKnowledgeFreshness(knowledge(repository.directory, [
      { type: "session", source: "session-1", timestamp: "2026-10-02T10:00:00.000Z" },
    ]), { workspaceDirectory: repository.directory });
    expect(sessionOnly.status).toBe("unverifiable");
    expect(sessionOnly.evidence[0]?.reason).toBe("not_file_evidence");
  });

  it.each([
    ["missing Git", "git_unavailable" as const],
    ["timeout", "timeout" as const],
  ])("reports %s as unverifiable", async (_name, failure) => {
    const repository = await newRepository();
    const runner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: null, stdout: "", failure })),
    };
    const report = await checkKnowledgeFreshness(
      knowledge(repository.directory, [fileEvidence("a".repeat(40))]),
      { workspaceDirectory: repository.directory, runner },
    );
    expect(report.status).toBe("unverifiable");
    expect(report.evidence[0]?.status).toBe("unverifiable");
  });

  it("handles malformed Git output and bounds evidence checks", async () => {
    const validRepository = await newRepository();
    await expect(compareFileSnapshots({
      workspaceDirectory: validRepository.directory,
      provenances: [{ commit: "not-a-full-object-id", path: "src/policy.ts" }],
    })).resolves.toEqual([{ status: "unverifiable", reason: "invalid_commit" }]);

    const malformedRunner: GitCommandRunner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "not-an-absolute-root\n" })),
    };
    const malformed = await checkKnowledgeFreshness(
      knowledge(validRepository.directory, [fileEvidence("a".repeat(40))]),
      { workspaceDirectory: validRepository.directory, runner: malformedRunner },
    );
    expect(malformed.evidence[0]).toMatchObject({ status: "unverifiable", reason: "malformed_output" });

    const repository = validRepository;
    const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
    const evidence = Array.from({ length: 18 }, (_, index) => fileEvidence(commit, `src/policy-${index}.ts`));
    const report = await checkKnowledgeFreshness(
      knowledge(repository.directory, evidence),
      { workspaceDirectory: repository.directory },
    );
    expect(report.evidence.slice(16).every(({ status }) => status === "unverifiable")).toBe(true);
  });

  it.each(["candidate", "verified", "superseded", "archived"] as const)(
    "does not change the %s lifecycle state",
    async (status) => {
      const repository = await newRepository();
      const commit = (await repository.git(["rev-parse", "HEAD"])).trim();
      const item = knowledge(repository.directory, [fileEvidence(commit)], status);
      await checkKnowledgeFreshness(item, { workspaceDirectory: repository.directory });
      expect(item.status).toBe(status);
    },
  );

  it("aggregates multiple evidence records and keeps their individual states", async () => {
    const repository = createTemporaryGitRepository();
    repositories.push(repository);
    await initializeGitRepository(repository.directory);
    repository.write("src/current.ts", "current\n");
    repository.write("src/changed.ts", "original\n");
    const commit = await repository.commit();
    repository.write("src/changed.ts", "changed\n");

    const report = await checkKnowledgeFreshness(knowledge(repository.directory, [
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
