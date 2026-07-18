interface ConfirmationEntry {
  action: (signal: AbortSignal) => Promise<boolean>;
  controller: AbortController;
  resolve: (confirmed: boolean) => void;
  reject: (error: unknown) => void;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
  settled: boolean;
}

export class ConfirmationCoordinator {
  private readonly queue: ConfirmationEntry[] = [];
  private active?: ConfirmationEntry;

  run(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve, reject) => {
      const entry: ConfirmationEntry = {
        action,
        controller: new AbortController(),
        resolve,
        reject,
        externalSignal: signal,
        settled: false,
      };
      if (signal) {
        entry.onExternalAbort = () => {
          entry.controller.abort(signal.reason);
          if (this.active !== entry) {
            const index = this.queue.indexOf(entry);
            if (index >= 0) this.queue.splice(index, 1);
            this.settle(entry, false);
          }
        };
        signal.addEventListener("abort", entry.onExternalAbort, { once: true });
      }
      this.queue.push(entry);
      this.drain();
    });
  }

  reset(reason = "Confirmation coordinator reset"): void {
    this.active?.controller.abort(reason);
    for (const entry of this.queue.splice(0)) {
      entry.controller.abort(reason);
      this.settle(entry, false);
    }
  }

  private drain(): void {
    if (this.active) return;
    const entry = this.queue.shift();
    if (!entry) return;
    if (entry.controller.signal.aborted) {
      this.settle(entry, false);
      this.drain();
      return;
    }

    this.active = entry;
    let actionResult: Promise<boolean>;
    try {
      actionResult = entry.action(entry.controller.signal);
    } catch (error) {
      this.fail(entry, error);
      this.active = undefined;
      this.drain();
      return;
    }
    void actionResult.then(
      (confirmed) => this.settle(entry, confirmed),
      (error) => this.fail(entry, error),
    ).finally(() => {
      if (this.active === entry) this.active = undefined;
      this.drain();
    });
  }

  private settle(entry: ConfirmationEntry, confirmed: boolean): void {
    if (entry.settled) return;
    entry.settled = true;
    this.cleanup(entry);
    entry.resolve(confirmed);
  }

  private fail(entry: ConfirmationEntry, error: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.cleanup(entry);
    entry.reject(error);
  }

  private cleanup(entry: ConfirmationEntry): void {
    if (entry.externalSignal && entry.onExternalAbort) {
      entry.externalSignal.removeEventListener("abort", entry.onExternalAbort);
    }
  }
}
