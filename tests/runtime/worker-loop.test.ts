import { describe, expect, it, vi } from "vitest";

import { runWorkerLoop } from "../../src/runtime/worker-loop.js";

describe("runWorkerLoop", () => {
  it("keeps draining handled work and stops on abort", async () => {
    const controller = new AbortController();
    let calls = 0;

    await runWorkerLoop({
      signal: controller.signal,
      idleDelayMs: 0,
      work: async () => {
        calls += 1;
        if (calls === 3) controller.abort();
        return true;
      },
    });

    expect(calls).toBe(3);
  });

  it("reports an error without terminating the worker", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    let calls = 0;

    await runWorkerLoop({
      signal: controller.signal,
      errorDelayMs: 0,
      onError,
      work: async () => {
        calls += 1;
        if (calls === 1) throw new Error("database unavailable");
        controller.abort();
        return false;
      },
    });

    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("wakes an idle wait immediately when aborted", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const loop = runWorkerLoop({
      signal: controller.signal,
      idleDelayMs: 10_000,
      work: async () => false,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await loop;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
