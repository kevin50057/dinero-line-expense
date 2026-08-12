export interface WorkerLoopOptions {
  readonly signal: AbortSignal;
  /** Return true when one unit was handled, false when the queue was empty. */
  readonly work: () => Promise<boolean>;
  readonly idleDelayMs?: number;
  readonly errorDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** Runs one bounded unit at a time so shutdown and backpressure stay simple. */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const idleDelayMs = validDelay(options.idleDelayMs ?? 100, "idleDelayMs");
  const errorDelayMs = validDelay(options.errorDelayMs ?? 1_000, "errorDelayMs");

  while (!options.signal.aborted) {
    try {
      const handled = await options.work();
      if (!handled) {
        await abortableDelay(idleDelayMs, options.signal);
      }
    } catch (error) {
      options.onError?.(error);
      await abortableDelay(errorDelayMs, options.signal);
    }
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function validDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new Error(`${name} must be an integer from 0 to 60000`);
  }
  return value;
}
