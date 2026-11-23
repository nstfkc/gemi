import { describe, expect, test } from "vitest";
import { WorkerPool, WorkerTimeoutError } from "./WorkerPool";

/**
 * The pool on its own, with a thread source standing in for the application:
 * it waits `boot` ms before `ready`, and answers each job with its own
 * `threadId` after `args` ms. The application-backed paths are in
 * `workerThread.test.ts`.
 */
const source = (boot = 0) => () => `
import { threadId } from "node:worker_threads";
await new Promise((r) => setTimeout(r, ${boot}));
self.onmessage = async (event) => {
  const { id, args } = event.data;
  await new Promise((r) => setTimeout(r, Number(args)));
  self.postMessage({ id, result: threadId });
};
self.postMessage({ ready: true });
`;

describe("WorkerPool", () => {
  test("a retired pool finishes its running job and hands waiting ones to its successor", async () => {
    const old = new WorkerPool({ size: 1, bootTimeoutMs: 10_000, source: source() });
    const next = new WorkerPool({ size: 1, bootTimeoutMs: 10_000, source: source() });
    try {
      const running = old.run("Job", "300", 10_000);
      const waiting = old.run("Job", "0", 10_000);
      // Let the first job reach its thread.
      await new Promise((r) => setTimeout(r, 150));
      old.retireWhenIdle(next);
      const later = old.run("Job", "0", 10_000);

      const [first, second, third] = await Promise.all([running, waiting, later]);
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      expect(old.threads).toBe(0);
      expect(next.threads).toBe(1);
    } finally {
      old.close();
      next.close();
    }
  });

  test("retiring ends idle threads at once", async () => {
    const old = new WorkerPool({ size: 1, bootTimeoutMs: 10_000, source: source() });
    const next = new WorkerPool({ size: 1, bootTimeoutMs: 10_000, source: source() });
    try {
      await old.run("Job", "0", 10_000);
      expect(old.threads).toBe(1);
      old.retireWhenIdle(next);
      expect(old.threads).toBe(0);
      expect(next.threads).toBe(0);
    } finally {
      next.close();
    }
  });

  test("a thread that is ready after its boot timed out is not handed a job", async () => {
    const pool = new WorkerPool({ size: 1, bootTimeoutMs: 50, source: source(300) });
    try {
      await expect(pool.run("Job", "0", 10_000)).rejects.toBeInstanceOf(WorkerTimeoutError);
      expect(pool.threads).toBe(0);
      // Long enough for the terminated thread's ready, had it been posted.
      await new Promise((r) => setTimeout(r, 400));
      expect(pool.threads).toBe(0);
    } finally {
      pool.close();
    }
  });
});
