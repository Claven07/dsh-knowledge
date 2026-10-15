import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, vi } from "vitest";
import { gitTest } from "./git-fixtures.js";

vi.mock("node:child_process", { spy: true });

type ProcessError = Error & { code?: string | number; killed?: boolean; signal?: string };

const it = gitTest.extend<{
  boundary: {
    started(): Promise<void>;
    callback(error: ProcessError): void;
    close(): void;
  };
}>({
  boundary: async ({ gitScope: _scope }, use) => {
    const child = new EventEmitter();
    let callback!: (error: ProcessError, stdout: string) => void;
    const spy = vi.spyOn(childProcess, "execFile").mockImplementation(((...args: unknown[]) => {
      expect(args[0]).toBe("git");
      expect(args[2]).toMatchObject({ shell: false, killSignal: "SIGKILL" });
      callback = args[3] as typeof callback;
      return child;
    }) as typeof childProcess.execFile);
    try {
      await use({
        started: async () => { await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); },
        callback: (error) => callback(error, ""),
        close: () => { child.emit("close"); },
      });
    } finally {
      child.emit("close");
      spy.mockRestore();
    }
  },
});

it.for([
  ["cancellation", { code: "ABORT_ERR", name: "AbortError" }, "cancelled"],
  ["timeout", { killed: true, signal: "SIGKILL" }, "timeout"],
  ["missing Git", { code: "ENOENT" }, "git_unavailable"],
  ["output limit", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "command_failed"],
  ["spawn error", { code: "EACCES" }, "command_failed"],
  ["nonzero exit", { code: 2 }, "not_repository"],
] as const)("awaits close after %s before settling the native operation", async ([, properties, reason], { gitScope: scope, boundary }) => {
  const directory = scope.temporaryDirectory();
  let settled = false;
  const operation = scope.capture({ workspaceDirectory: directory, filePath: "policy.ts" })
    .then((result) => { settled = true; return result; });
  await boundary.started();
  boundary.callback(Object.assign(new Error("controlled process failure"), properties));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  boundary.close();
  await expect(operation).resolves.toEqual({ status: "skipped", reason });
});
