type ActiveHealthRequest = {
  owner: symbol;
  controller: AbortController;
  settled: Promise<void>;
};

let activeHealthRequest: ActiveHealthRequest | undefined;

/** Process-local, fail-fast gate for model-facing health requests only. */
export class HarnessHealthRequestGate {
  private readonly owner = Symbol("dsh-knowledge-health-owner");
  private disposed = false;

  async run<T>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    onBusy: () => T,
  ): Promise<T> {
    if (this.disposed || activeHealthRequest !== undefined) {
      return onBusy();
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const active: ActiveHealthRequest = {
      owner: this.owner,
      controller,
      settled: operationPromise.then(() => undefined, () => undefined),
    };
    activeHealthRequest = active;

    try {
      return await operationPromise;
    } finally {
      callerSignal.removeEventListener("abort", forwardAbort);
      if (activeHealthRequest === active) {
        activeHealthRequest = undefined;
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = activeHealthRequest;
    if (active?.owner === this.owner) {
      active.controller.abort();
      await active.settled;
    }
  }
}
