import { afterEach, describe, expect, test, vi } from "vitest";

import { Job } from "./Job";
import type { MemoryQueueDriver } from "./MemoryQueueDriver";
import { QueueManager } from "./QueueManager";

/**
 * Per-key throttles and concurrency, `release` and `fail` (#661), on the
 * memory driver. Several workers over one database are in
 * `services/lock/DatabaseLockStore.test.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(10);
  }
}

describe("throttle", () => {
  test("a job over its budget waits for the window without spending an attempt", async () => {
    const runs: Array<{ user: string; attempt: number; at: number }> = [];
    const start = Date.now();
    class SendPush extends Job {
      static name = "SendPush";
      maxAttempts = 1;
      throttle(user: string) {
        return [
          { key: "push:global", limit: 10, window: 60_000 },
          { key: `push:user:${user}`, limit: 2, window: 1_000 },
        ];
      }
      run(user: string) {
        runs.push({ user, attempt: 0, at: Date.now() - start });
      }
    }
    const queue = new QueueManager({ jobs: [SendPush], concurrency: 4, pollInterval: 20 });
    for (const user of ["a", "a", "a", "b"]) await queue.push(SendPush, JSON.stringify([user]));

    await until(() => runs.length === 4);
    const a = runs.filter((run) => run.user === "a");
    // The third "a" ran in the next window, not dead-lettered (maxAttempts 1).
    expect(a).toHaveLength(3);
    expect(a[2]!.at).toBeGreaterThanOrEqual(950);
    expect(runs.find((run) => run.user === "b")!.at).toBeLessThan(900);
    expect((queue.driver as MemoryQueueDriver).waiting).toBe(0);
  });

  test("a refused second throttle refunds the first", async () => {
    let runs = 0;
    class Two extends Job {
      static name = "Two";
      throttle() {
        return [
          { key: "outer", limit: 1, window: 60_000 },
          { key: "inner", limit: 0, window: 200 },
        ];
      }
      run() {
        runs++;
      }
    }
    const queue = new QueueManager({ jobs: [Two], pollInterval: 20 });
    await queue.push(Two, "[]");
    await sleep(100);
    expect(runs).toBe(0);
    // The outer budget was not used up by the refused admissions.
    expect((await queue.locks.store.hit("gemi:throttle:outer", 1, 60_000)).allowed).toBe(true);
    await queue.stop();
  });
});

describe("concurrency", () => {
  test("caps how many jobs with one key run at once", async () => {
    let running = 0;
    let most = 0;
    let done = 0;
    class Sync extends Job {
      static name = "Sync";
      concurrency(account: string) {
        return { key: `sync:${account}`, limit: 2 };
      }
      async run() {
        running++;
        most = Math.max(most, running);
        await sleep(40);
        running--;
        done++;
      }
    }
    const queue = new QueueManager({ jobs: [Sync], concurrency: 8, pollInterval: 10 });
    for (let i = 0; i < 6; i++) await queue.push(Sync, '["acme"]');
    await until(() => done === 6);
    expect(most).toBe(2);
    // Every slot is free again.
    for (let i = 0; i < 2; i++) {
      expect(await queue.locks.store.holder(`gemi:concurrency:sync:acme:${i}`)).toBeNull();
    }
  });
});

describe("release and fail from run", () => {
  test("release puts the job back without counting the attempt or calling hooks", async () => {
    const attempts: number[] = [];
    const hooks: string[] = [];
    let calls = 0;
    class RateLimited extends Job {
      static name = "RateLimited";
      maxAttempts = 1;
      run() {
        calls++;
        if (calls < 3) this.release(30);
      }
      onSuccess() {
        hooks.push("success");
      }
      onFail() {
        hooks.push("fail");
      }
    }
    const queue = new QueueManager({ jobs: [RateLimited] });
    const claim = vi.spyOn(queue.driver, "claim");
    await queue.push(RateLimited, "[]");
    await until(() => hooks.length === 1);
    for (const result of claim.mock.results) {
      for (const job of await result.value) attempts.push(job.attempt);
    }
    expect(calls).toBe(3);
    expect(attempts).toEqual([1, 1, 1]);
    expect(hooks).toEqual(["success"]);
  });

  test("fail with retry: false dead-letters at once", async () => {
    const hooks: string[] = [];
    let calls = 0;
    class Uncertain extends Job {
      static name = "Uncertain";
      maxAttempts = 5;
      run() {
        calls++;
        this.fail(new Error("accepted?"), { retry: false });
      }
      onFail(error: Error) {
        hooks.push(`fail:${error.message}`);
      }
      onDeadletter() {
        hooks.push("dead");
      }
    }
    const queue = new QueueManager({ jobs: [Uncertain] });
    await queue.push(Uncertain, "[]");
    await until(() => hooks.length === 2);
    await sleep(30);
    expect(calls).toBe(1);
    expect(hooks).toEqual(["fail:accepted?", "dead"]);
  });

  test("fail with retry retries like a throw", async () => {
    let calls = 0;
    class Flaky extends Job {
      static name = "Flaky";
      maxAttempts = 3;
      run() {
        calls++;
        if (calls < 3) this.fail("try again");
      }
    }
    const queue = new QueueManager({ jobs: [Flaky] });
    await queue.push(Flaky, "[]");
    await until(() => calls === 3);
  });
});
