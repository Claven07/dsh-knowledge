import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { GitProvenance } from "./types.js";

export const MAX_GIT_EVIDENCE_CHECKS = 16;
export const MAX_GIT_PATH_CHARS = 4_096;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 1_500;
export const DEFAULT_GIT_OPERATION_BUDGET_MS = 8_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

const GIT_GLOBAL_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "--literal-pathspecs",
] as const;

export type GitCommandFailure =
  | "git_unavailable"
  | "timeout"
  | "operation_budget_exceeded"
  | "output_limit"
  | "spawn_error";

/** Result returned by the process boundary. stderr is intentionally discarded. */
export type GitCommandResult = {
  exitCode: number | null;
  stdout: string;
  failure?: GitCommandFailure;
};

/** Injectable command boundary for deterministic tests and alternate hosts. */
export interface GitCommandRunner {
  run(
    cwd: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<GitCommandResult>;
}

export type GitInspectionOptions = {
  /** Defaults to the native Git executable runner. */
  runner?: GitCommandRunner;
  /** Per-command limit; callers may lower the 1.5 second hard maximum. */
  commandTimeoutMs?: number;
  /** Total command budget; callers may lower the 8 second hard maximum. */
  operationBudgetMs?: number;
};

export type GitOperationReason =
  | "invalid_workspace"
  | "invalid_path"
  | "not_repository"
  | "git_unavailable"
  | "missing_head"
  | "file_not_in_head"
  | "working_tree_changed"
  | "unsafe_path"
  | "unsafe_index_state"
  | "unsafe_filter"
  | "invalid_commit"
  | "missing_commit"
  | "missing_path_at_commit"
  | "timeout"
  | "operation_budget_exceeded"
  | "command_failed"
  | "malformed_output";

export type FileProvenanceCapture =
  | { status: "captured"; provenance: GitProvenance }
  | { status: "skipped"; reason: GitOperationReason };

export type FileSnapshotComparison = {
  status: "current" | "potentially_stale" | "unverifiable";
  reason?: GitOperationReason;
};

export type CaptureFileProvenanceOptions = GitInspectionOptions & {
  workspaceDirectory: string;
  filePath: string;
};

export type CompareFileSnapshotsOptions = GitInspectionOptions & {
  workspaceDirectory: string;
  provenances: readonly GitProvenance[];
};

type Budget = {
  runner: GitCommandRunner;
  startedAt: number;
  commandTimeoutMs: number;
  operationBudgetMs: number;
};

type GitRootResult =
  | { root: string; head: string }
  | { reason: GitOperationReason };

/**
 * Captures the committed snapshot for a clean, tracked file. This function
 * never reads file contents or changes the repository.
 */
export async function captureFileProvenance(
  options: CaptureFileProvenanceOptions,
): Promise<FileProvenanceCapture> {
  let path: string;
  try {
    path = normalizeRepositoryRelativePath(options.filePath);
  } catch {
    return { status: "skipped", reason: "invalid_path" };
  }

  const budget = makeBudget(options);
  const discovered = await discoverRootAndHead(options.workspaceDirectory, budget);
  if ("reason" in discovered) {
    return { status: "skipped", reason: discovered.reason };
  }

  const tree = await runGit(discovered.root, [
    "ls-tree", "-z", "--full-tree", "HEAD", "--", path,
  ], budget);
  const treeResult = exactTreeEntries(tree, [path]);
  if (treeResult.reason !== undefined) {
    return { status: "skipped", reason: treeResult.reason };
  }
  if (!treeResult.found.has(path)) {
    return { status: "skipped", reason: "file_not_in_head" };
  }

  const localState = await inspectLocalFile(discovered.root, path);
  if (localState === "missing") {
    return { status: "skipped", reason: "working_tree_changed" };
  }
  if (localState === "unsafe") {
    return { status: "skipped", reason: "unsafe_path" };
  }

  const indexState = await inspectIndexPaths(discovered.root, [path], budget);
  if (indexState.reason !== undefined) {
    return { status: "skipped", reason: indexState.reason };
  }
  if (!indexState.present.has(path)) {
    return { status: "skipped", reason: "working_tree_changed" };
  }
  if (indexState.unsafe.has(path)) {
    return { status: "skipped", reason: "unsafe_index_state" };
  }

  const filterCheck = await checkSafeFilters(discovered.root, [path], budget);
  if (filterCheck.reason !== undefined) {
    return { status: "skipped", reason: filterCheck.reason };
  }
  if (filterCheck.unsafe.has(path)) {
    return { status: "skipped", reason: "unsafe_filter" };
  }

  const diff = await runGit(discovered.root, [
    "diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", path,
  ], budget);
  const diffFailure = commandFailureReason(diff);
  if (diffFailure !== undefined) {
    return { status: "skipped", reason: diffFailure };
  }
  if (diff.exitCode === 1) {
    return { status: "skipped", reason: "working_tree_changed" };
  }
  if (diff.exitCode !== 0) {
    return { status: "skipped", reason: "command_failed" };
  }

  return {
    status: "captured",
    provenance: { commit: discovered.head, path },
  };
}

/**
 * Compares up to 16 file snapshots with the current working tree. Commands
 * are grouped by commit, and each invocation is bounded by the shared budget.
 */
export async function compareFileSnapshots(
  options: CompareFileSnapshotsOptions,
): Promise<FileSnapshotComparison[]> {
  const results: FileSnapshotComparison[] = options.provenances.map(() => ({
    status: "unverifiable",
    reason: "operation_budget_exceeded",
  }));
  if (options.provenances.length === 0) {
    return results;
  }

  const budget = makeBudget(options);
  const count = Math.min(options.provenances.length, MAX_GIT_EVIDENCE_CHECKS);
  for (let index = MAX_GIT_EVIDENCE_CHECKS; index < results.length; index += 1) {
    results[index] = { status: "unverifiable", reason: "operation_budget_exceeded" };
  }

  const normalizedProvenances: Array<GitProvenance | undefined> = [];
  for (let index = 0; index < count; index += 1) {
    const item = options.provenances[index]!;
    let commit: string;
    let path: string;
    try {
      commit = normalizeGitCommit(item.commit);
    } catch {
      normalizedProvenances[index] = undefined;
      results[index] = { status: "unverifiable", reason: "invalid_commit" };
      continue;
    }
    try {
      path = normalizeRepositoryRelativePath(item.path);
    } catch {
      normalizedProvenances[index] = undefined;
      results[index] = { status: "unverifiable", reason: "invalid_path" };
      continue;
    }
    normalizedProvenances[index] = { commit, path };
  }

  const validItems = normalizedProvenances
    .map((provenance, index) => provenance === undefined ? undefined : { provenance, index })
    .filter((item): item is { provenance: GitProvenance; index: number } => item !== undefined);
  if (validItems.length === 0) {
    return results;
  }

  const discovered = await discoverRootAndHead(options.workspaceDirectory, budget);
  if ("reason" in discovered) {
    for (const item of validItems) {
      results[item.index] = { status: "unverifiable", reason: discovered.reason };
    }
    return results;
  }

  const uniquePaths = [...new Set(validItems.map(({ provenance }) => provenance.path))];
  const localStates = new Map<string, "present" | "missing" | "unsafe">();
  for (const path of uniquePaths) {
    localStates.set(path, await inspectLocalFile(discovered.root, path));
  }
  const inspectablePaths = uniquePaths.filter((path) => localStates.get(path) === "present");
  const indexState = await inspectIndexPaths(discovered.root, inspectablePaths, budget);
  const filterCheck = await checkSafeFilters(discovered.root, inspectablePaths, budget);

  const byCommit = new Map<string, Array<{ provenance: GitProvenance; index: number }>>();
  for (const item of validItems) {
    const group = byCommit.get(item.provenance.commit) ?? [];
    group.push(item);
    byCommit.set(item.provenance.commit, group);
  }

  for (const [commit, items] of byCommit) {
    const commitResult = await runGit(discovered.root, [
      "rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`,
    ], budget);
    const commitFailure = commandFailureReason(commitResult);
    if (commitFailure !== undefined) {
      setUnverifiable(results, items, commitFailure);
      continue;
    }
    if (commitResult.exitCode !== 0) {
      setUnverifiable(results, items, "missing_commit");
      continue;
    }
    const resolvedCommit = stripOneNewline(commitResult.stdout);
    if (!isGitCommit(resolvedCommit)) {
      setUnverifiable(results, items, "malformed_output");
      continue;
    }

    const commitPaths = [...new Set(items.map(({ provenance }) => provenance.path))];
    const tree = await runGit(discovered.root, [
      "ls-tree", "-z", "--full-tree", resolvedCommit, "--", ...commitPaths,
    ], budget);
    const treeResult = exactTreeEntries(tree, commitPaths);
    if (treeResult.reason !== undefined) {
      setUnverifiable(results, items, treeResult.reason);
      continue;
    }
    const absent = new Set(commitPaths.filter((path) => !treeResult.found.has(path)));
    const checkable: Array<{ provenance: GitProvenance; index: number }> = [];
    for (const item of items) {
      if (absent.has(item.provenance.path)) {
        results[item.index] = { status: "unverifiable", reason: "missing_path_at_commit" };
        continue;
      }
      const path = item.provenance.path;
      const localState = localStates.get(path);
      if (localState === "missing") {
        results[item.index] = { status: "potentially_stale", reason: "working_tree_changed" };
        continue;
      }
      if (localState === "unsafe") {
        results[item.index] = { status: "unverifiable", reason: "unsafe_path" };
        continue;
      }
      if (indexState.reason !== undefined) {
        results[item.index] = { status: "unverifiable", reason: indexState.reason };
        continue;
      }
      if (!indexState.present.has(path)) {
        results[item.index] = { status: "potentially_stale", reason: "working_tree_changed" };
        continue;
      }
      if (indexState.unsafe.has(path)) {
        results[item.index] = { status: "unverifiable", reason: "unsafe_index_state" };
        continue;
      }
      if (filterCheck.reason !== undefined) {
        results[item.index] = { status: "unverifiable", reason: filterCheck.reason };
        continue;
      }
      if (filterCheck.unsafe.has(path)) {
        results[item.index] = { status: "unverifiable", reason: "unsafe_filter" };
        continue;
      }
      checkable.push(item);
    }
    if (checkable.length === 0) {
      continue;
    }

    const diff = await runGit(discovered.root, [
      "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      resolvedCommit, "--", ...new Set(checkable.map(({ provenance }) => provenance.path)),
    ], budget);
    const diffFailure = commandFailureReason(diff);
    if (diffFailure !== undefined) {
      setUnverifiable(results, checkable, diffFailure);
      continue;
    }
    if (diff.exitCode !== 0) {
      setUnverifiable(results, checkable, "command_failed");
      continue;
    }
    const changed = parseNulPaths(diff.stdout);
    if (changed === undefined) {
      setUnverifiable(results, checkable, "malformed_output");
      continue;
    }
    const changedSet = new Set(changed);
    for (const item of checkable) {
      results[item.index] = changedSet.has(item.provenance.path)
        ? { status: "potentially_stale", reason: "working_tree_changed" }
        : { status: "current" };
    }
  }

  return results;
}

/** Normalizes and validates a Git repository-relative path. */
export function normalizeRepositoryRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_GIT_PATH_CHARS || input.includes("\0")) {
    throw new TypeError("Git path must be a non-empty path without NUL characters.");
  }
  if (
    input.startsWith("/") || input.startsWith("\\") ||
    /^[A-Za-z]:/.test(input) || isAbsolute(input) || win32.isAbsolute(input)
  ) {
    throw new TypeError("Git path must be repository-relative.");
  }

  const segments = input.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new TypeError("Git path must not traverse outside the repository.");
  }
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (normalized.length === 0) {
    throw new TypeError("Git path must identify a file.");
  }
  return normalized;
}

/** Validates a full SHA-1 or SHA-256 Git object ID and returns lowercase hex. */
export function normalizeGitCommit(input: string): string {
  if (!isGitCommit(input)) {
    throw new TypeError("Git commit must be a full SHA-1 or SHA-256 object ID.");
  }
  return input.toLowerCase();
}

function isGitCommit(value: string): boolean {
  return typeof value === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value);
}

function makeBudget(options: GitInspectionOptions): Budget {
  const requestedCommandTimeout = options.commandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const requestedOperationBudget = options.operationBudgetMs ?? DEFAULT_GIT_OPERATION_BUDGET_MS;
  if (!Number.isFinite(requestedCommandTimeout) || requestedCommandTimeout < 1) {
    throw new RangeError("Git command timeout must be a positive finite number.");
  }
  if (!Number.isFinite(requestedOperationBudget) || requestedOperationBudget < 1) {
    throw new RangeError("Git operation budget must be a positive finite number.");
  }
  return {
    runner: options.runner ?? nativeGitRunner,
    startedAt: Date.now(),
    commandTimeoutMs: Math.min(requestedCommandTimeout, DEFAULT_GIT_COMMAND_TIMEOUT_MS),
    operationBudgetMs: Math.min(requestedOperationBudget, DEFAULT_GIT_OPERATION_BUDGET_MS),
  };
}

async function discoverRootAndHead(
  workspaceDirectory: string,
  budget: Budget,
): Promise<GitRootResult> {
  if (
    typeof workspaceDirectory !== "string" || workspaceDirectory.length === 0 ||
    workspaceDirectory.includes("\0") ||
    (!isAbsolute(workspaceDirectory) && !win32.isAbsolute(workspaceDirectory))
  ) {
    return { reason: "invalid_workspace" };
  }
  try {
    const workspaceStat = await stat(workspaceDirectory);
    if (!workspaceStat.isDirectory()) {
      return { reason: "invalid_workspace" };
    }
  } catch {
    return { reason: "invalid_workspace" };
  }

  const rootResult = await runGit(workspaceDirectory, ["rev-parse", "--show-toplevel"], budget);
  const rootFailure = commandFailureReason(rootResult);
  if (rootFailure !== undefined) {
    return { reason: rootFailure };
  }
  if (rootResult.exitCode !== 0) {
    return { reason: "not_repository" };
  }
  const root = stripOneNewline(rootResult.stdout);
  if (
    root.length === 0 || root.includes("\n") || root.includes("\0") ||
    (!isAbsolute(root) && !win32.isAbsolute(root))
  ) {
    return { reason: "malformed_output" };
  }

  const headResult = await runGit(root, [
    "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}",
  ], budget);
  const headFailure = commandFailureReason(headResult);
  if (headFailure !== undefined) {
    return { reason: headFailure };
  }
  if (headResult.exitCode !== 0) {
    return { reason: "missing_head" };
  }
  const head = stripOneNewline(headResult.stdout);
  if (!isGitCommit(head)) {
    return { reason: "malformed_output" };
  }
  return { root, head: head.toLowerCase() };
}

type IndexPathInspection = {
  present: Set<string>;
  unsafe: Set<string>;
  reason?: GitOperationReason;
};

type FilterInspection = {
  unsafe: Set<string>;
  reason?: GitOperationReason;
};

async function inspectLocalFile(
  root: string,
  repositoryPath: string,
): Promise<"present" | "missing" | "unsafe"> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unsafe";
    }
    if (entry.isSymbolicLink()) {
      return "unsafe";
    }
    const isFinal = index === segments.length - 1;
    if (isFinal ? !entry.isFile() : !entry.isDirectory()) {
      return isFinal ? "unsafe" : "missing";
    }
  }
  return "present";
}

async function inspectIndexPaths(
  cwd: string,
  paths: readonly string[],
  budget: Budget,
): Promise<IndexPathInspection> {
  const present = new Set<string>();
  const unsafe = new Set<string>();
  if (paths.length === 0) {
    return { present, unsafe };
  }
  const result = await runGit(cwd, ["ls-files", "-v", "-z", "--", ...paths], budget);
  const failure = commandFailureReason(result);
  if (failure !== undefined) {
    return { present, unsafe, reason: failure };
  }
  if (result.exitCode !== 0) {
    return { present, unsafe, reason: "command_failed" };
  }
  const entries = splitNul(result.stdout);
  if (entries === undefined) {
    return { present, unsafe, reason: "malformed_output" };
  }
  const expected = new Set(paths);
  for (const entry of entries) {
    if (entry.length < 3 || entry[1] !== " ") {
      return { present, unsafe, reason: "malformed_output" };
    }
    const path = entry.slice(2);
    if (!expected.has(path)) {
      return { present, unsafe, reason: "malformed_output" };
    }
    if (present.has(path)) {
      unsafe.add(path);
    }
    present.add(path);
    // `ls-files -v` lowercases assume-unchanged entries and reports
    // skip-worktree/unmerged entries with a non-H tag. Their worktree state
    // cannot be trusted for a snapshot comparison.
    if (entry[0] !== "H") {
      unsafe.add(path);
    }
  }
  return { present, unsafe };
}

async function checkSafeFilters(
  cwd: string,
  paths: readonly string[],
  budget: Budget,
): Promise<FilterInspection> {
  const unsafe = new Set<string>();
  if (paths.length === 0) {
    return { unsafe };
  }
  for (const cached of [false, true]) {
    const result = await runGit(cwd, [
      "check-attr", ...(cached ? ["--cached"] : []), "-z", "filter", "--", ...paths,
    ], budget);
    const failure = commandFailureReason(result);
    if (failure !== undefined) {
      return { unsafe, reason: failure };
    }
    if (result.exitCode !== 0) {
      return { unsafe, reason: "command_failed" };
    }
    const values = parseCheckAttr(result.stdout, paths);
    if (values === undefined) {
      return { unsafe, reason: "malformed_output" };
    }
    values.forEach((value, index) => {
      if (value !== "unspecified" && value !== "unset") {
        unsafe.add(paths[index]!);
      }
    });
  }
  return { unsafe };
}

function parseCheckAttr(output: string, expectedPaths: readonly string[]): string[] | undefined {
  const fields = splitNul(output);
  if (fields === undefined || fields.length !== expectedPaths.length * 3) {
    return undefined;
  }
  const values: string[] = [];
  for (let index = 0; index < expectedPaths.length; index += 1) {
    const offset = index * 3;
    if (fields[offset] !== expectedPaths[index] || fields[offset + 1] !== "filter") {
      return undefined;
    }
    values.push(fields[offset + 2]!);
  }
  return values;
}

function exactTreeEntries(
  result: GitCommandResult,
  paths: readonly string[],
): { found: Set<string>; reason?: GitOperationReason } {
  const failure = commandFailureReason(result);
  if (failure !== undefined) {
    return { found: new Set(), reason: failure };
  }
  if (result.exitCode !== 0) {
    return { found: new Set(), reason: "command_failed" };
  }
  const entries = splitNul(result.stdout);
  if (entries === undefined) {
    return { found: new Set(), reason: "malformed_output" };
  }
  const expected = new Set(paths);
  const found = new Set<string>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      return { found: new Set(), reason: "malformed_output" };
    }
    const metadata = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (metadata.length !== 3 || !expected.has(path)) {
      return { found: new Set(), reason: "malformed_output" };
    }
    if (metadata[1] === "blob") {
      found.add(path);
    }
  }
  return { found };
}

function parseNulPaths(output: string): string[] | undefined {
  if (output.length === 0) {
    return [];
  }
  const fields = splitNul(output);
  return fields;
}

function splitNul(output: string): string[] | undefined {
  if (output.length === 0) {
    return [];
  }
  if (!output.endsWith("\0")) {
    return undefined;
  }
  return output.slice(0, -1).split("\0");
}

function stripOneNewline(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function commandFailureReason(result: GitCommandResult): GitOperationReason | undefined {
  if (result.failure === "git_unavailable") return "git_unavailable";
  if (result.failure === "timeout") return "timeout";
  if (result.failure === "operation_budget_exceeded") return "operation_budget_exceeded";
  if (result.failure === "output_limit" || result.failure === "spawn_error") return "command_failed";
  if (result.exitCode === null) return "command_failed";
  return undefined;
}

function setUnverifiable(
  results: FileSnapshotComparison[],
  items: readonly { index: number }[],
  reason: GitOperationReason,
): void {
  for (const item of items) {
    results[item.index] = { status: "unverifiable", reason };
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  budget: Budget,
): Promise<GitCommandResult> {
  const remaining = budget.operationBudgetMs - (Date.now() - budget.startedAt);
  if (remaining <= 0) {
    return { exitCode: null, stdout: "", failure: "operation_budget_exceeded" };
  }
  return await budget.runner.run(
    cwd,
    [...GIT_GLOBAL_ARGS, ...args],
    Math.max(1, Math.min(budget.commandTimeoutMs, remaining)),
  );
}

const nativeGitRunner: GitCommandRunner = {
  run(cwd, args, timeoutMs) {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        // Git environment variables can redirect repository discovery, inject
        // configuration, or make Git write trace output to an arbitrary path.
        if (key.toUpperCase().startsWith("GIT_")) {
          delete env[key];
        }
      }
      env.GIT_OPTIONAL_LOCKS = "0";

      execFile(
        "git",
        [...args],
        {
          cwd,
          env,
          encoding: "utf8",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          shell: false,
          timeout: timeoutMs,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout });
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            resolve({ exitCode: null, stdout, failure: "git_unavailable" });
          } else if (
            code === "ETIMEDOUT" || error.killed || error.signal === "SIGTERM" ||
            error.signal === "SIGKILL"
          ) {
            resolve({ exitCode: null, stdout, failure: "timeout" });
          } else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve({ exitCode: null, stdout, failure: "output_limit" });
          } else if (typeof code === "number") {
            resolve({ exitCode: code, stdout });
          } else {
            resolve({ exitCode: null, stdout, failure: "spawn_error" });
          }
        },
      );
    });
  },
};
