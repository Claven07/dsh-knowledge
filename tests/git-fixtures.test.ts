import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { GitTestScope, gitTest as it } from "./git-fixtures.js";

it("waits for outstanding work before disposal and rejects late work", async ({ gitScope: scope }) => {
  let release!: () => void;
  let removed = false;
  const pending = scope.track(() => new Promise<void>((resolve) => { release = resolve; }));
  scope.own(async () => { removed = true; });
  const disposal = scope.cleanup();
  expect(scope.signal.aborted).toBe(true);
  expect(removed).toBe(false);
  expect(() => scope.repository()).toThrow();
  expect(() => scope.git(".", ["--version"])).toThrow();
  release();
  await pending;
  await disposal;
  expect(removed).toBe(true);
});

it("attempts every cleanup and retains failed resources for retry", async ({ gitScope: scope }) => {
  const failure = new Error("removal denied");
  let attempts = 0;
  const laterCleanup = vi.fn(async () => {});
  scope.own(async () => { if (++attempts === 1) throw failure; });
  scope.own(laterCleanup);
  await expect(scope.cleanup()).rejects.toMatchObject({ errors: [failure] });
  expect(laterCleanup).toHaveBeenCalledTimes(1);
  await scope.cleanup();
  expect(attempts).toBe(2);
  expect(laterCleanup).toHaveBeenCalledTimes(1);
});

it("shares an in-flight disposal without removing resources twice", async ({ gitScope: scope }) => {
  const cleanup = vi.fn(async () => {});
  scope.own(cleanup);
  const first = scope.cleanup();
  expect(scope.cleanup()).toBe(first);
  await first;
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("kills a cancelled child and awaits close before removing its cwd", async ({ gitScope: owner }) => {
  const controller = new AbortController();
  const scope = new GitTestScope(AbortSignal.any([owner.signal, controller.signal]));
  owner.own(() => scope.cleanup());
  const directory = scope.temporaryDirectory("dsh-knowledge-child-close-");
  const pidFile = join(directory, "pid");
  const pending = scope.process(process.execPath, ["-e", `
    require('node:fs').writeFileSync('pid', String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], directory).then(() => undefined, (error: Error) => error);
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
  const pid = Number(readFileSync(pidFile, "utf8"));
  controller.abort();
  await scope.cleanup();
  expect(await pending).toMatchObject({ cause: { code: "ABORT_ERR" } });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(existsSync(directory)).toBe(false);
});

it("terminates timed-out processes and reports the timeout", async ({ gitScope: scope }) => {
  const directory = scope.temporaryDirectory();
  await expect(scope.process(process.execPath, ["-e", "setInterval(() => {}, 1000)"], directory, 50))
    .rejects.toMatchObject({ cause: { killed: true, signal: "SIGKILL" } });
  await scope.cleanup();
  expect(existsSync(directory)).toBe(false);
});

it("reports process spawn failures", async ({ gitScope: scope }) => {
  const directory = scope.temporaryDirectory();
  await expect(scope.process(join(directory, "missing-executable"), [], directory))
    .rejects.toMatchObject({ cause: { code: "ENOENT" } });
});

it("preserves a failed process exit code and stderr", async ({ gitScope: scope }) => {
  const directory = scope.temporaryDirectory();
  await expect(scope.process(process.execPath, ["-e", "process.stderr.write('fixture failure'); process.exit(7)"], directory))
    .rejects.toMatchObject({ message: expect.stringContaining("fixture failure"), cause: { code: 7 } });
});

it("keeps independent test scopes isolated", async ({ gitScope: owner }) => {
  const first = new GitTestScope(owner.signal);
  const second = new GitTestScope(owner.signal);
  owner.own(() => first.cleanup());
  owner.own(() => second.cleanup());
  const firstDirectory = first.temporaryDirectory();
  const secondDirectory = second.temporaryDirectory();
  await first.cleanup();
  expect(existsSync(firstDirectory)).toBe(false);
  expect(second.signal.aborted).toBe(false);
  await expect(second.process(process.execPath, ["-e", "process.stdout.write('alive')"], secondDirectory))
    .resolves.toBe("alive");
});
