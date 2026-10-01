import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type TemporaryGitRepository = {
  directory: string;
  git(args: readonly string[]): Promise<string>;
  write(path: string, content: string): void;
  commit(message?: string): Promise<string>;
  cleanup(): void;
};

export function createTemporaryGitRepository(
  prefix = "dsh-knowledge-git-",
): TemporaryGitRepository {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const git = (args: readonly string[]) => runGit(directory, args);
  return {
    directory,
    git,
    write(path: string, content: string) {
      const target = join(directory, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    },
    async commit(message = "fixture") {
      await git(["add", "--all"]);
      await git(["commit", "--quiet", "-m", message]);
      return (await git(["rev-parse", "HEAD"])).trim();
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function initializeGitRepository(directory: string): Promise<void> {
  await runGit(directory, ["init", "--quiet", "-b", "main"]);
  await runGit(directory, ["config", "user.email", "dsh-knowledge-test@example.invalid"]);
  await runGit(directory, ["config", "user.name", "dsh-knowledge-test"]);
}

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024, shell: false, timeout: 10_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Git fixture command failed (${String((error as NodeJS.ErrnoException).code)}): ${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
