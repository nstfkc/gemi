import { describe, expect, test } from "vitest";

import type { QueueDriver } from "./QueueDriver";

/**
 * What every `QueueDriver` promises the `QueueManager`, as a suite a driver's
 * own test file runs against itself:
 *
 *     queueDriverContract("MemoryQueueDriver", () => new MemoryQueueDriver());
 *
 * Each test gets a fresh driver from `create`, with empty storage — a driver
 * backed by a database truncates in its factory, or hands out a fresh table.
 * `cleanup`, when given, runs after each test with that driver.
 *
 * Not a `*.test.ts` file, so vitest never runs it on its own, and not exported
 * from `gemi/services`, because it imports vitest.
 *
 * The timing tests use real, short leases and delays rather than fake timers,
 * because a driver measuring time on its database's clock cannot be faked from
 * here. `LEASE` and `SHORT` leave a wide margin; a flake under heavy load is a
 * margin to widen, not a driver bug to chase.
 */
export function queueDriverContract(
  name: string,
  create: () => QueueDriver | Promise<QueueDriver>,
  cleanup?: (driver: QueueDriver) => void | Promise<void>,
) {
  const LEASE = { visibilityTimeoutMs: 60_000 };
  const SHORT = 150;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const withDriver = (body: (driver: QueueDriver) => Promise<void>) => async () => {
    const driver = await create();
    try {
      await body(driver);
    } finally {
      await cleanup?.(driver);
    }
  };

  describe(`${name} — the QueueDriver contract`, () => {
    test(
      "enqueue returns distinct ids, and claim hands the job back as attempt 1",
      withDriver(async (driver) => {
        const a = await driver.enqueue({ name: "A", args: '[{"n":1}]' });
        const b = await driver.enqueue({ name: "B", args: "[]" });
        expect(a).not.toBe(b);

        const claimed = await driver.claim(10, LEASE);

        expect(claimed.map((job) => job.id)).toEqual([a, b]);
        expect(claimed[0]).toMatchObject({
          id: a,
          name: "A",
          args: '[{"n":1}]',
          attempt: 1,
        });
        expect(typeof claimed[0]!.createdAt).toBe("number");
      }),
    );

    test(
      "claim respects its limit, oldest first",
      withDriver(async (driver) => {
        const ids = [];
        for (let i = 0; i < 3; i++) {
          ids.push(await driver.enqueue({ name: "A", args: `[${i}]` }));
        }

        const first = await driver.claim(2, LEASE);
        const second = await driver.claim(2, LEASE);

        expect(first.map((job) => job.id)).toEqual(ids.slice(0, 2));
        expect(second.map((job) => job.id)).toEqual(ids.slice(2));
      }),
    );

    test(
      "a claimed job is not handed out again while its lease holds",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });

        expect(await driver.claim(1, LEASE)).toHaveLength(1);
        expect(await driver.claim(1, LEASE)).toEqual([]);
      }),
    );

    test(
      "concurrent claims never share a job",
      withDriver(async (driver) => {
        for (let i = 0; i < 20; i++) {
          await driver.enqueue({ name: "A", args: `[${i}]` });
        }

        const batches = await Promise.all(Array.from({ length: 5 }, () => driver.claim(8, LEASE)));
        const ids = batches.flat().map((job) => job.id);

        expect(ids).toHaveLength(20);
        expect(new Set(ids).size).toBe(20);
      }),
    );

    test(
      "complete ends the job for good",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [job] = await driver.claim(1, { visibilityTimeoutMs: SHORT });

        await driver.complete(job!);
        await sleep(SHORT * 2);

        expect(await driver.claim(1, LEASE)).toEqual([]);
      }),
    );

    test(
      "fail with a retry makes the job claimable again after the delay, as the next attempt",
      withDriver(async (driver) => {
        const id = await driver.enqueue({ name: "A", args: "[7]" });
        const [job] = await driver.claim(1, LEASE);

        await driver.fail(job!, { error: "boom", retryInMs: SHORT });

        expect(await driver.claim(1, LEASE)).toEqual([]);
        await sleep(SHORT * 2);

        const [again] = await driver.claim(1, LEASE);
        expect(again).toMatchObject({ id, name: "A", args: "[7]", attempt: 2 });
      }),
    );

    test(
      "fail with retryInMs 0 is claimable at once",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [job] = await driver.claim(1, LEASE);

        await driver.fail(job!, { error: "boom", retryInMs: 0 });

        expect(await driver.claim(1, LEASE)).toHaveLength(1);
      }),
    );

    test(
      "fail with retryInMs null dead-letters: never claimed again",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [job] = await driver.claim(1, { visibilityTimeoutMs: SHORT });

        await driver.fail(job!, { error: "boom", retryInMs: null });
        await sleep(SHORT * 2);

        expect(await driver.claim(1, LEASE)).toEqual([]);
      }),
    );

    test(
      "enqueue with a delay is not claimable until it has passed",
      withDriver(async (driver) => {
        const id = await driver.enqueue({
          name: "A",
          args: "[]",
          delayMs: SHORT,
        });

        expect(await driver.claim(1, LEASE)).toEqual([]);
        await sleep(SHORT * 2);
        expect((await driver.claim(1, LEASE)).map((job) => job.id)).toEqual([id]);
      }),
    );

    test(
      "a lease that runs out makes the job claimable again, and counts the lost attempt",
      withDriver(async (driver) => {
        const id = await driver.enqueue({ name: "A", args: "[]" });
        await driver.claim(1, { visibilityTimeoutMs: SHORT });

        await sleep(SHORT * 2);
        const [again] = await driver.claim(1, LEASE);

        // The crash-recovery path: nobody reported, and the next claimer gets
        // it with the dead attempt already counted.
        expect(again).toMatchObject({ id, attempt: 2 });
      }),
    );

    test(
      "a report from a claim whose lease was re-issued is ignored",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [stale] = await driver.claim(1, { visibilityTimeoutMs: SHORT });
        await sleep(SHORT * 2);
        const [current] = await driver.claim(1, { visibilityTimeoutMs: SHORT });

        // The slow first claimer finishes late. Neither report may end the
        // claim that now holds the job, or two processes would each believe
        // the other's outcome.
        await driver.complete(stale!);
        await driver.fail(stale!, { error: "late", retryInMs: null });
        await sleep(SHORT * 2);

        const [third] = await driver.claim(1, LEASE);
        expect(third).toMatchObject({ id: current!.id, attempt: 3 });
      }),
    );

    test(
      "heartbeat extends a lease, when the driver has one",
      withDriver(async (driver) => {
        if (!driver.heartbeat) return;
        await driver.enqueue({ name: "A", args: "[]" });
        const short = { visibilityTimeoutMs: SHORT * 2 };
        const [job] = await driver.claim(1, short);

        // Kept alive past two whole lease lengths, by beats inside each.
        for (let i = 0; i < 4; i++) {
          await sleep(SHORT);
          await driver.heartbeat([job!], short);
        }

        expect(await driver.claim(1, LEASE)).toEqual([]);
        await driver.complete(job!);
      }),
    );

    test(
      "subscribe, when the driver has it, wakes on enqueue and on a delay passing",
      withDriver(async (driver) => {
        if (!driver.subscribe) return;
        let wakes = 0;
        const unsubscribe = driver.subscribe(() => wakes++);

        await driver.enqueue({ name: "A", args: "[]" });
        expect(wakes).toBeGreaterThan(0);

        const before = wakes;
        await driver.enqueue({ name: "B", args: "[]", delayMs: SHORT });
        await sleep(SHORT * 2);
        expect(wakes).toBeGreaterThan(before);

        unsubscribe();
        const after = wakes;
        await driver.enqueue({ name: "C", args: "[]" });
        expect(wakes).toBe(after);
      }),
    );
  });
}
