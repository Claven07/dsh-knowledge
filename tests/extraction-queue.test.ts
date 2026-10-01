import { describe, expect, it, vi } from "vitest";
import { BoundedExtractionQueue } from "../src/harness/extraction.js";

type Job = { key: string; group: string; value: number };

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function queue(
  process: (job: Job, signal: AbortSignal) => void | Promise<void>,
  capacity = 8,
  onError = vi.fn(),
): BoundedExtractionQueue<Job> {
  return new BoundedExtractionQueue({
    capacity,
    keyOf: ({ key }) => key,
    groupOf: ({ group }) => group,
    process,
    onError,
  });
}

describe("bounded extraction queue", () => {
  it("bounds queued work and drops overflow", async () => {
    const gate = deferred();
    const worker = queue(async (job) => {
      if (job.value === 1) {
        await gate.promise;
      }
    }, 1);
    expect(worker.enqueue({ key: "one", group: "session", value: 1 })).toBe("queued");
    await nextImmediate();
    expect(worker.enqueue({ key: "two", group: "session", value: 2 })).toBe("queued");
    expect(worker.enqueue({ key: "three", group: "session", value: 3 })).toBe("queue_full");
    expect(worker.queuedCount).toBe(1);
    expect(worker.activeCount).toBe(1);
    gate.resolve();
    await worker.whenIdle();
  });

  it("allows only one active worker and deduplicates a session-turn key", async () => {
    let active = 0;
    let maximumActive = 0;
    const processed: number[] = [];
    const worker = queue(async (job) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      processed.push(job.value);
      active -= 1;
    });
    expect(worker.enqueue({ key: "session-1:turn-4", group: "session-1", value: 1 })).toBe("queued");
    expect(worker.enqueue({ key: "session-1:turn-4", group: "session-1", value: 2 })).toBe("duplicate");
    worker.enqueue({ key: "session-2:turn-1", group: "session-2", value: 3 });

    await worker.whenIdle();
    expect(maximumActive).toBe(1);
    expect(processed).toEqual([1, 3]);
  });

  it("cancels queued and active work by owner/session group", async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const worker = queue(async (_job, activeSignal) => {
      signal = activeSignal;
      await gate.promise;
    });
    worker.enqueue({ key: "a:turn-1", group: "a", value: 1 });
    await nextImmediate();
    worker.enqueue({ key: "a:turn-2", group: "a", value: 2 });
    worker.cancelGroup("a");
    expect(signal?.aborted).toBe(true);
    expect(worker.queuedCount).toBe(0);
    gate.resolve();
    await worker.whenIdle();
  });

  it("closes intake, cancels queued work, and bounds active shutdown", async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const worker = queue(async (_job, activeSignal) => {
      signal = activeSignal;
      await gate.promise;
    });
    worker.enqueue({ key: "active", group: "owner", value: 1 });
    await nextImmediate();
    worker.enqueue({ key: "queued", group: "owner", value: 2 });
    const before = Date.now();
    await worker.close(20);
    expect(Date.now() - before).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
    expect(worker.enqueue({ key: "later", group: "owner", value: 3 })).toBe("closed");
    expect(worker.queuedCount).toBe(0);
    gate.resolve();
    await worker.whenIdle();
  });
});
