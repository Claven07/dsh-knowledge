import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { captureFileProvenance, compareFileSnapshots } from "../src/knowledge/git.js";
import { checkKnowledgeFreshness } from "../src/knowledge/freshness.js";
import { checkKnowledgeHealth, checkKnowledgeHealthBatch } from "../src/knowledge/health.js";

export type TemporaryGitRepository = {
  directory: string;
  git(args: readonly string[]): Promise<string>;
  write(path: string, content: string): void;
  commit(message?: string): Promise<string>;
};

/** Each test owns its cancellation, outstanding work, and cleanup queue. */
export class GitTestScope {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources = new Set<() => Promise<void>>();
  private readonly signals = new Map<AbortSignal, AbortSignal>();
  private disposing = false;
  private cleanupPromise?: Promise<void>;
  private readonly abortFromParent = () => this.controller.abort(this.parent?.reason);

  constructor(private readonly parent?: AbortSignal) {
    if (parent?.aborted) this.abortFromParent();
    else parent?.addEventListener("abort", this.abortFromParent, { once: true });
  }

  get signal(): AbortSignal { return this.controller.signal; }

  signalFor(signal?: AbortSignal): AbortSignal {
    if (signal === undefined || signal === this.signal) return this.signal;
    let combined = this.signals.get(signal);
    if (combined === undefined) {
      combined = AbortSignal.any([this.signal, signal]);
      this.signals.set(signal, combined);
      this.signals.set(combined, combined);
    }
    return combined;
  }

  private assertActive(): void {
    this.signal.throwIfAborted();
    if (this.disposing) throw new Error("Git test scope is disposing");
  }

  track<T>(start: () => Promise<T>): Promise<T> {
    this.assertActive();
    const operation = start();
    this.pending.add(operation);
    // Keep rejection on the returned promise for the caller's assertions.
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  own(cleanup: () => Promise<void>): void {
    this.assertActive();
    this.resources.add(cleanup);
  }

  directory(directory: string): string {
    this.own(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  temporaryDirectory(prefix = "dsh-knowledge-git-"): string {
    this.assertActive();
    return this.directory(mkdtempSync(join(tmpdir(), prefix)));
  }

  repository(prefix = "dsh-knowledge-git-"): TemporaryGitRepository {
    const directory = this.temporaryDirectory(prefix);
    const git = (args: readonly string[]) => this.git(directory, args);
    return {
      directory,
      git,
      write: (path, content) => {
        this.assertActive();
        const target = join(directory, ...path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      },
      async commit(message = "fixture") {
        await git(["add", "--all"]);
        await git(["commit", "--quiet", "-m", message]);
        return (await git(["rev-parse", "HEAD"])).trim();
      },
    };
  }

  async initialize(directory: string): Promise<void> {
    await this.git(directory, ["init", "--quiet", "-b", "main"]);
    await this.git(directory, ["config", "user.email", "dsh-knowledge-test@example.invalid"]);
    await this.git(directory, ["config", "user.name", "dsh-knowledge-test"]);
  }

  async newRepository(prefix = "dsh-knowledge-git-"): Promise<TemporaryGitRepository> {
    const repository = this.repository(prefix);
    await this.initialize(repository.directory);
    repository.write("src/policy.ts", "export const policy = 'allow';\n");
    await repository.commit("initial");
    return repository;
  }

  git(cwd: string, args: readonly string[]): Promise<string> {
    return this.process("git", args, cwd);
  }

  /** The callback can precede close on abort; settlement must follow both. */
  process(executable: string, args: readonly string[], cwd: string, timeoutMs = 10_000): Promise<string> {
    return this.track(() => new Promise<string>((resolve, reject) => {
      let closed = false;
      let outcome: { error: Error | null; stdout: string } | undefined;
      const settle = () => {
        if (!closed || outcome === undefined) return;
        if (outcome.error !== null) reject(outcome.error);
        else resolve(outcome.stdout);
      };
      const child = execFile(executable, [...args], {
        cwd, encoding: "utf8", maxBuffer: 64 * 1024, shell: false,
        timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, signal: this.signal,
      }, (error, stdout, stderr) => {
        outcome = {
          error: error === null ? null : new Error(
            `Fixture process failed (${String(error.code)}, ${String(error.signal)}): ${stderr}`,
            { cause: error },
          ),
          stdout,
        };
        settle();
      });
      child.once("close", () => { closed = true; settle(); });
    }));
  }

  capture: typeof captureFileProvenance = (options) => this.track(() =>
    captureFileProvenance({ ...options, signal: this.signalFor(options.signal) }));
  compare: typeof compareFileSnapshots = (options) => this.track(() =>
    compareFileSnapshots({ ...options, signal: this.signalFor(options.signal) }));
  freshness: typeof checkKnowledgeFreshness = (item, options) => this.track(() =>
    checkKnowledgeFreshness(item, { ...options, signal: this.signalFor(options.signal) }));
  health: typeof checkKnowledgeHealth = (item, options) => this.track(() =>
    checkKnowledgeHealth(item, { ...options, signal: this.signalFor(options.signal) }));
  healthBatch: typeof checkKnowledgeHealthBatch = (items, options) => this.track(() =>
    checkKnowledgeHealthBatch(items, { ...options, signal: this.signalFor(options.signal) }));

  cleanup(): Promise<void> {
    if (this.cleanupPromise !== undefined) return this.cleanupPromise;
    this.disposing = true;
    this.controller.abort(new DOMException("Git test scope disposed", "AbortError"));
    this.cleanupPromise = this.dispose().finally(() => { this.cleanupPromise = undefined; });
    return this.cleanupPromise;
  }

  private async dispose(): Promise<void> {
    const errors: unknown[] = [];
    // A continuation may settle after its command; drain all tracked work first.
    while (this.pending.size > 0) {
      const settled = await Promise.allSettled([...this.pending]);
      for (const result of settled) {
        if (result.status === "rejected" && result.reason !== this.signal.reason && !isCancellation(result.reason)) errors.push(result.reason);
      }
    }
    for (const cleanup of this.resources) {
      try {
        await cleanup();
        this.resources.delete(cleanup);
      } catch (error) {
        errors.push(error);
      }
    }
    this.parent?.removeEventListener("abort", this.abortFromParent);
    if (errors.length > 0) throw new AggregateError(errors, "Git test scope cleanup failed");
  }
}

function isCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || (error.cause instanceof Error && error.cause.name === "AbortError");
}

export const gitTest = test.extend<{ gitScope: GitTestScope }>({
  gitScope: async ({ signal }, use) => {
    const scope = new GitTestScope(signal);
    try { await use(scope); }
    finally { await scope.cleanup(); }
  },
});
