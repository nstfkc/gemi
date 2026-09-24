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
 * `features.claimsByName` says the driver honours `ClaimOptions.registered`,
 * and runs the tests that pin what that means. A driver that leaves it out
 * must still accept the option; the suite passes it to every claim it makes
 * outside those tests, with `A`, `B` and `C` registered, so ignoring it
 * correctly is covered too.
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
  features: { claimsByName?: boolean } = {},
) {
  // Every name the ordinary tests enqueue is registered, so a driver that
  // filters by name behaves in them exactly as one that does not.
  const registered = { names: ["A", "B", "C"], graceMs: 60_000 };
  const LEASE = { visibilityTimeoutMs: 60_000, registered };
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
        const [job] = await driver.claim(1, { visibilityTimeoutMs: SHORT, registered });

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
        const [job] = await driver.claim(1, { visibilityTimeoutMs: SHORT, registered });

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
      "order is by when a job became claimable, not by when it was enqueued",
      withDriver(async (driver) => {
        // The one case where the two readings of "oldest first" disagree, and
        // the reason the interface says which it means. `delayed` was recorded
        // first but was not claimable until later, so `immediate` — which has
        // actually been waiting — goes first. A driver ordering by creation
        // time gets the opposite answer, and a job asked to wait five minutes
        // then jumps ahead of everything enqueued during those five minutes.
        const delayed = await driver.enqueue({
          name: "A",
          args: "[]",
          delayMs: SHORT,
        });
        const immediate = await driver.enqueue({ name: "B", args: "[]" });

        await sleep(SHORT * 2);

        const claimed = await driver.claim(10, LEASE);
        expect(claimed.map((job) => job.id)).toEqual([immediate, delayed]);
      }),
    );

    test(
      "a lease that runs out makes the job claimable again, and counts the lost attempt",
      withDriver(async (driver) => {
        const id = await driver.enqueue({ name: "A", args: "[]" });
        await driver.claim(1, { visibilityTimeoutMs: SHORT, registered });

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
        const [stale] = await driver.claim(1, { visibilityTimeoutMs: SHORT, registered });
        await sleep(SHORT * 2);
        const [current] = await driver.claim(1, { visibilityTimeoutMs: SHORT, registered });

        // The slow first claimer finishes late. No report of its may end the
        // claim that now holds the job, or two processes would each believe
        // the other's outcome.
        //
        // The retry is checked first, and while the second lease is at its
        // freshest, because it is the branch a driver is likeliest to get
        // wrong: the other two delete the row, and an author who puts the
        // attempt check on the delete and not on the update that sends a row
        // back to waiting passes every other test here. In production that
        // driver re-opens a job another worker is running right now — two live
        // runs at one attempt, which is the whole of what `attempt` is for. So
        // the second claim must still be exclusive afterwards.
        await driver.fail(stale!, { error: "late", retryInMs: 0 });
        expect(await driver.claim(1, LEASE)).toEqual([]);

        await driver.complete(stale!);
        await driver.fail(stale!, { error: "late", retryInMs: null });
        await sleep(SHORT * 2);

        const [third] = await driver.claim(1, LEASE);
        expect(third).toMatchObject({ id: current!.id, attempt: 3 });
      }),
    );

    test(
      "release makes the job claimable again after the delay, without counting the claim",
      withDriver(async (driver) => {
        const id = await driver.enqueue({ name: "A", args: "[7]" });
        const [job] = await driver.claim(1, LEASE);

        await driver.release(job!, { retryInMs: SHORT });

        expect(await driver.claim(1, LEASE)).toEqual([]);
        await sleep(SHORT * 2);

        // Attempt 1 again: the claim that was given back never ran it, so a
        // job allowed one attempt still has it.
        const [again] = await driver.claim(1, LEASE);
        expect(again).toMatchObject({ id, name: "A", args: "[7]", attempt: 1 });

        // And the count moves on from there, rather than having been reset.
        await driver.fail(again!, { error: "boom", retryInMs: 0 });
        const [third] = await driver.claim(1, LEASE);
        expect(third).toMatchObject({ id, attempt: 2 });
      }),
    );

    test(
      "release with retryInMs 0 is claimable at once",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [job] = await driver.claim(1, LEASE);

        await driver.release(job!, { retryInMs: 0 });

        expect(await driver.claim(1, LEASE)).toMatchObject([{ attempt: 1 }]);
      }),
    );

    test(
      "a release from a claim whose lease was re-issued is ignored",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [stale] = await driver.claim(1, { visibilityTimeoutMs: SHORT, registered });
        await sleep(SHORT * 2);
        const [current] = await driver.claim(1, LEASE);

        // Honoured, it would re-open a job another worker is running and take
        // back an attempt that worker is making.
        await driver.release(stale!, { retryInMs: 0 });

        expect(await driver.claim(1, LEASE)).toEqual([]);
        await driver.fail(current!, { error: "boom", retryInMs: 0 });
        expect(await driver.claim(1, LEASE)).toMatchObject([{ attempt: 3 }]);
      }),
    );

    if (features.claimsByName) {
      test(
        "claim leaves a job under a name it was not given, and it does not use up the limit",
        withDriver(async (driver) => {
          // The unknown one first, so a driver that applied the limit before
          // the filter would hand back one job instead of two.
          const unknown = await driver.enqueue({ name: "NewRelease", args: "[]" });
          const a = await driver.enqueue({ name: "A", args: "[]" });
          const b = await driver.enqueue({ name: "B", args: "[]" });
          const only = { names: ["A", "B"], graceMs: 60_000 };

          const claimed = await driver.claim(2, { visibilityTimeoutMs: 60_000, registered: only });
          expect(claimed.map((job) => job.id)).toEqual([a, b]);
          expect(await driver.claim(2, { visibilityTimeoutMs: 60_000, registered: only })).toEqual(
            [],
          );

          // A process that knows the name takes it, as its first attempt.
          const [taken] = await driver.claim(1, {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["NewRelease"], graceMs: 60_000 },
          });
          expect(taken).toMatchObject({ id: unknown, attempt: 1 });
        }),
      );

      test(
        "an empty registry claims nothing inside the grace window",
        withDriver(async (driver) => {
          await driver.enqueue({ name: "A", args: "[]" });

          expect(
            await driver.claim(1, {
              visibilityTimeoutMs: 60_000,
              registered: { names: [], graceMs: 60_000 },
            }),
          ).toEqual([]);
        }),
      );

      test(
        "a job under an unknown name is handed out once it has been claimable for the grace window",
        withDriver(async (driver) => {
          const id = await driver.enqueue({ name: "Removed", args: "[]" });
          const lease = {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["A"], graceMs: SHORT },
          };

          expect(await driver.claim(1, lease)).toEqual([]);
          await sleep(SHORT * 2);

          // Past the window the name is taken to be gone, and the claimer gets
          // it so that it can be dead-lettered rather than wait forever.
          expect(await driver.claim(1, lease)).toMatchObject([{ id, attempt: 1 }]);
        }),
      );

      test(
        "the grace window runs from when a job became claimable, not from when it was enqueued",
        withDriver(async (driver) => {
          // Delayed past the window. Due now, it has been waiting for no time
          // at all, and a replica that knows the name may be about to take it.
          await driver.enqueue({ name: "Delayed", args: "[]", delayMs: SHORT * 2 });
          await sleep(SHORT * 3);
          const lease = {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["A"], graceMs: SHORT * 2 },
          };

          expect(await driver.claim(1, lease)).toEqual([]);
          await sleep(SHORT * 3);
          expect(await driver.claim(1, lease)).toHaveLength(1);
        }),
      );

      test(
        "a lapsed lease under an unknown name waits out the grace window from the lapse",
        withDriver(async (driver) => {
          // Three clocks a lapsed row could be measured by, spaced a whole
          // grace window apart so only the lapse keeps it back: enqueued at 0,
          // claimed at 2, lapsed at 4, looked at by the old replica at 5, in
          // units of SHORT, against a window of 2. Measured from `created_at`
          // or `claimed_at` it would already be handed out.
          const id = await driver.enqueue({ name: "NewRelease", args: "[]" });
          await sleep(SHORT * 2);
          // A replica that knew the name claimed it and died.
          await driver.claim(1, {
            visibilityTimeoutMs: SHORT * 2,
            registered: { names: ["NewRelease"], graceMs: 60_000 },
          });
          await sleep(SHORT * 3);

          const old = {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["A"], graceMs: SHORT * 2 },
          };
          expect(await driver.claim(1, old)).toEqual([]);

          await sleep(SHORT * 2);
          const [again] = await driver.claim(1, old);
          expect(again).toMatchObject({ id, attempt: 2 });
        }),
      );
    }

    test(
      "heartbeat extends a lease, when the driver has one",
      withDriver(async (driver) => {
        if (!driver.heartbeat) return;
        await driver.enqueue({ name: "A", args: "[]" });
        const short = { visibilityTimeoutMs: SHORT * 2, registered };
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
