import { describe, expect, test } from "vitest";

import type { BatchStatus } from "./batch";
import type { EnqueueBatch, QueueDriver } from "./QueueDriver";

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
 * `features.transaction` runs a callback inside the kind of transaction
 * `joinsTransaction` looks for — for the database driver, an ORM transaction
 * on its own connection — committing when the callback resolves and rolling
 * back when it rejects. `joins` says whether the driver writes into it. With
 * `joins: true` the suite checks the outbox: a job enqueued inside is not
 * claimable until the commit and is gone after a rollback. With `false` it
 * checks that the driver says so, because the manager then holds the dispatch
 * until the commit itself; that half is `QueueManager.transaction.test.ts`.
 *
 * `features.batches` runs the batch tests: `enqueueBatch`, the counters
 * `complete` and `fail` keep, `findBatch`, `cancelBatch` and `reportProgress`.
 *
 * Not a `*.test.ts` file, so vitest never runs it on its own, and not exported
 * from `gemi/services`, because it imports vitest.
 *
 * The timing tests use real, short leases and delays rather than fake timers,
 * because a driver measuring time on its database's clock cannot be faked from
 * here. Waiting for a delay or a lease to pass is safe on any runner: the
 * sleep only ever makes it longer. Asserting that one has *not* passed yet is
 * not, because a loaded runner can take longer than `SHORT` between two
 * statements, and then handing the job out is right. Those assertions go
 * through `notYet`, which makes them only when the client saw too little time
 * pass for the driver to be allowed to — see there.
 */
export function queueDriverContract(
  name: string,
  create: () => QueueDriver | Promise<QueueDriver>,
  cleanup?: (driver: QueueDriver) => void | Promise<void>,
  features: {
    claimsByName?: boolean;
    transaction?: {
      run(driver: QueueDriver, fn: () => Promise<void>): Promise<void>;
      joins: boolean;
    };
    /** The driver implements the batch methods, and runs the tests that pin them. */
    batches?: boolean;
  } = {},
) {
  // Every name the ordinary tests enqueue is registered, so a driver that
  // filters by name behaves in them exactly as one that does not.
  const registered = { names: ["A", "B", "C"], graceMs: 60_000 };
  const LEASE = { visibilityTimeoutMs: 60_000, registered };
  const SHORT = 150;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Starts a clock on the client, read as milliseconds since the call.
   * Started before a statement is sent, it bounds the database's clock from
   * both sides: that statement ran after the start, and any statement that
   * has returned by the time it is read ran before the reading. So the
   * database saw at most the reading pass between the two, whatever offset
   * its clock runs at from the client's.
   */
  const stopwatch = () => {
    const start = Date.now();
    return () => Date.now() - start;
  };

  /**
   * `claimed` must be empty if less than `ms` can have passed on the
   * database since `elapsed` started, read after `claimed` came back. Past
   * that, the runner was slow enough that the job may rightly be due, and a
   * driver is allowed either answer. The 2 ms is the rounding of two
   * millisecond clocks, the database's and the client's.
   *
   * A driver that hands a job out early still fails on any runner that is not
   * starved, which is every run but the one that flaked.
   */
  const notYet = (claimed: unknown[], elapsed: () => number, ms: number) => {
    if (elapsed() + 2 < ms) expect(claimed).toEqual([]);
  };

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
        const enqueued: string[] = [];
        for (let i = 0; i < 20; i++) {
          enqueued.push(await driver.enqueue({ name: "A", args: `[${i}]` }));
        }

        // Not all 20 in one round: a claimer that meets a row another holds
        // skips it, which is what `SKIP LOCKED` is for, and leaves it for the
        // next claim — on MySQL routinely, where one claimer can hold rows it
        // is not taking. So rounds, as workers polling would. Every round
        // that finds work claims some of it, so 20 rounds is far more than
        // enough, and a queue that stops draining fails below rather than
        // spinning.
        const ids: string[] = [];
        for (let round = 0; round < 20 && ids.length < 20; round++) {
          const batches = await Promise.all(
            Array.from({ length: 5 }, () => driver.claim(8, LEASE)),
          );
          ids.push(...batches.flat().map((job) => job.id));
        }

        // Never shared: the property this is named for.
        expect(new Set(ids).size).toBe(ids.length);
        // And none lost: every job enqueued was handed out, and nothing else.
        expect([...ids].sort()).toEqual([...enqueued].sort());
        expect(await driver.claim(8, LEASE)).toEqual([]);
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

        const elapsed = stopwatch();
        await driver.fail(job!, { error: "boom", retryInMs: SHORT });

        const early = await driver.claim(1, LEASE);
        notYet(early, elapsed, SHORT);
        if (!early.length) await sleep(SHORT * 2);

        const [again] = early.length ? early : await driver.claim(1, LEASE);
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
        const elapsed = stopwatch();
        const id = await driver.enqueue({
          name: "A",
          args: "[]",
          delayMs: SHORT,
        });

        const early = await driver.claim(1, LEASE);
        notYet(early, elapsed, SHORT);
        if (!early.length) await sleep(SHORT * 2);

        const claimed = early.length ? early : await driver.claim(1, LEASE);
        expect(claimed.map((job) => job.id)).toEqual([id]);
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
        //
        // Only while `immediate` really was enqueued before `delayed` came
        // due: on a runner slow enough to take `SHORT` between the two, it
        // was not, and either order can be the right one.
        const elapsed = stopwatch();
        const delayed = await driver.enqueue({
          name: "A",
          args: "[]",
          delayMs: SHORT,
        });
        const immediate = await driver.enqueue({ name: "B", args: "[]" });
        const raced = elapsed() + 2 >= SHORT;

        await sleep(SHORT * 2);

        const claimed = (await driver.claim(10, LEASE)).map((job) => job.id);
        if (raced) expect([...claimed].sort()).toEqual([immediate, delayed].sort());
        else expect(claimed).toEqual([immediate, delayed]);
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
        const [current] = await driver.claim(1, LEASE);

        // The slow first claimer finishes late. No report of its may end the
        // claim that now holds the job, or two processes would each believe
        // the other's outcome.
        //
        // The retry is checked first because it is the branch a driver is
        // likeliest to get wrong: the other two delete the row, and an author
        // who puts the attempt check on the delete and not on the update that
        // sends a row back to waiting passes every other test here. In
        // production that driver re-opens a job another worker is running
        // right now — two live runs at one attempt, which is the whole of what
        // `attempt` is for. So the second claim must still be exclusive
        // afterwards.
        await driver.fail(stale!, { error: "late", retryInMs: 0 });
        expect(await driver.claim(1, LEASE)).toEqual([]);

        await driver.complete(stale!);
        await driver.fail(stale!, { error: "late", retryInMs: null });

        // The job is still there, still held by the second claim, and still
        // counting from it: that claim's own report is honoured, as the
        // third attempt. Deleted or dead-lettered by a stale report, there
        // would be nothing to claim.
        await driver.fail(current!, { error: "boom", retryInMs: 0 });
        const [third] = await driver.claim(1, LEASE);
        expect(third).toMatchObject({ id: current!.id, attempt: 3 });
      }),
    );

    test(
      "release makes the job claimable again after the delay, without counting the claim",
      withDriver(async (driver) => {
        const id = await driver.enqueue({ name: "A", args: "[7]" });
        const [job] = await driver.claim(1, LEASE);

        const elapsed = stopwatch();
        await driver.release(job!, { retryInMs: SHORT });

        const early = await driver.claim(1, LEASE);
        notYet(early, elapsed, SHORT);
        if (!early.length) await sleep(SHORT * 2);

        // Attempt 1 again: the claim that was given back never ran it, so a
        // job allowed one attempt still has it.
        const [again] = early.length ? early : await driver.claim(1, LEASE);
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
          const elapsed = stopwatch();
          const id = await driver.enqueue({ name: "Removed", args: "[]" });
          const lease = {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["A"], graceMs: SHORT },
          };

          const early = await driver.claim(1, lease);
          notYet(early, elapsed, SHORT);
          if (!early.length) await sleep(SHORT * 2);

          // Past the window the name is taken to be gone, and the claimer gets
          // it so that it can be dead-lettered rather than wait forever.
          const claimed = early.length ? early : await driver.claim(1, lease);
          expect(claimed).toMatchObject([{ id, attempt: 1 }]);
        }),
      );

      test(
        "the grace window runs from when a job became claimable, not from when it was enqueued",
        withDriver(async (driver) => {
          // Delayed past the window. Due now, it has been waiting for no time
          // at all, and a replica that knows the name may be about to take it.
          // Due at 2, out of the window at 4, in units of SHORT.
          const elapsed = stopwatch();
          await driver.enqueue({ name: "Delayed", args: "[]", delayMs: SHORT * 2 });
          await sleep(SHORT * 3);
          const lease = {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["A"], graceMs: SHORT * 2 },
          };

          const early = await driver.claim(1, lease);
          notYet(early, elapsed, SHORT * 4);
          if (!early.length) await sleep(SHORT * 3);
          expect(early.length ? early : await driver.claim(1, lease)).toHaveLength(1);
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
          // A replica that knew the name claimed it and died. Out of the
          // window at 4 after this claim.
          const elapsed = stopwatch();
          await driver.claim(1, {
            visibilityTimeoutMs: SHORT * 2,
            registered: { names: ["NewRelease"], graceMs: 60_000 },
          });
          await sleep(SHORT * 3);

          const old = {
            visibilityTimeoutMs: 60_000,
            registered: { names: ["A"], graceMs: SHORT * 2 },
          };
          const early = await driver.claim(1, old);
          notYet(early, elapsed, SHORT * 4);
          if (!early.length) await sleep(SHORT * 2);

          const [again] = early.length ? early : await driver.claim(1, old);
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
        // Each lease, the claim's or a beat's, has to be renewed before it
        // runs out: `widest` is the most the database can have seen pass
        // between one and the next, by the reasoning at `stopwatch`.
        let elapsed = stopwatch();
        let widest = 0;
        const [job] = await driver.claim(1, short);

        // Kept alive past two whole lease lengths, by beats inside each.
        for (let i = 0; i < 4; i++) {
          await sleep(SHORT);
          const next = stopwatch();
          await driver.heartbeat([job!], short);
          widest = Math.max(widest, elapsed());
          elapsed = next;
        }

        const claimed = await driver.claim(1, LEASE);
        widest = Math.max(widest, elapsed());
        notYet(claimed, () => widest, SHORT * 2);
        await driver.complete(job!);
      }),
    );

    test(
      "retryDead, when the driver has it, brings a dead job back as attempt 1, and nothing else",
      withDriver(async (driver) => {
        if (!driver.retryDead) return;
        const dead = await driver.enqueue({ name: "A", args: "[3]" });
        const [job] = await driver.claim(1, LEASE);
        await driver.fail(job!, { error: "boom", retryInMs: null });

        const waiting = await driver.enqueue({ name: "B", args: "[]", delayMs: 60_000 });
        const claimed = await driver.enqueue({ name: "C", args: "[]" });
        const [held] = await driver.claim(1, LEASE);
        expect(held!.id).toBe(claimed);

        // Only a dead job. Reviving a claimed one would reset the attempt its
        // holder is going to report under, so its `complete` would be refused
        // as stale and the job run again.
        expect(await driver.retryDead(waiting)).toBe(false);
        expect(await driver.retryDead(claimed)).toBe(false);
        expect(await driver.retryDead("no-such-job")).toBe(false);
        expect(await driver.claim(10, LEASE)).toEqual([]);

        expect(await driver.retryDead(dead)).toBe(true);
        const [again] = await driver.claim(10, LEASE);
        expect(again).toMatchObject({ id: dead, name: "A", args: "[3]", attempt: 1 });
        await driver.complete(again!);
        await driver.complete(held!);

        // Once, not twice: it is claimed now, so a second call finds nothing.
        expect(await driver.retryDead(dead)).toBe(false);
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

    test(
      "enqueue records a job under the id it is given",
      withDriver(async (driver) => {
        const given = crypto.randomUUID();
        expect(await driver.enqueue({ name: "A", args: "[]", id: given })).toBe(given);

        const [claimed] = await driver.claim(1, LEASE);
        expect(claimed).toMatchObject({ id: given, name: "A", attempt: 1 });
        // The report is matched by that id too, or the job would come back.
        await driver.complete(claimed!);
        expect(await driver.claim(1, LEASE)).toEqual([]);
      }),
    );

    test(
      "joinsTransaction, when the driver has it, is false outside a transaction",
      withDriver(async (driver) => {
        expect(driver.joinsTransaction?.() ?? false).toBe(false);
      }),
    );

    const transaction = features.transaction;
    if (transaction?.joins) {
      test(
        "a job enqueued inside a transaction is not claimable until the commit",
        withDriver(async (driver) => {
          let id: string | undefined;
          await transaction.run(driver, async () => {
            expect(driver.joinsTransaction?.()).toBe(true);
            id = await driver.enqueue({ name: "A", args: "[]" });
            // `claim` reads through a connection of its own, as another
            // replica's would, so this is what every claimer sees.
            expect(await driver.claim(10, LEASE)).toEqual([]);
          });

          const claimed = await driver.claim(10, LEASE);
          expect(claimed.map((job) => job.id)).toEqual([id]);
        }),
      );

      test(
        "a job enqueued inside a transaction that rolls back is never claimable",
        withDriver(async (driver) => {
          await expect(
            transaction.run(driver, async () => {
              await driver.enqueue({ name: "A", args: "[]" });
              throw new Error("rolled back");
            }),
          ).rejects.toThrow("rolled back");

          expect(await driver.claim(10, LEASE)).toEqual([]);
          // And the rollback took only that: the next job is still recorded.
          const after = await driver.enqueue({ name: "B", args: "[]" });
          expect((await driver.claim(10, LEASE)).map((job) => job.id)).toEqual([after]);
        }),
      );
    } else if (transaction) {
      test(
        "joinsTransaction is false inside a transaction it does not join",
        withDriver(async (driver) => {
          await transaction.run(driver, async () => {
            expect(driver.joinsTransaction?.() ?? false).toBe(false);
          });
        }),
      );
    }
  });

  if (!features.batches) return;

  describe(`${name} — batches`, () => {
    const batchOf = (
      id: string,
      count: number,
      options: Partial<Omit<EnqueueBatch, "id" | "args">> = {},
    ): EnqueueBatch => ({
      id,
      name: options.name ?? null,
      job: options.job ?? "A",
      args: Array.from({ length: count }, (_, n) => JSON.stringify([n])),
      allowFailures: options.allowFailures ?? false,
      callbacks: options.callbacks ?? {},
    });

    const callbacks = {
      then: { name: "B", args: ["then"] },
      catch: { name: "B", args: ["catch"] },
      finally: { name: "B", args: ["finally"] },
    };

    /** Claims everything claimable, batch jobs and callbacks alike. */
    const claimAll = (driver: QueueDriver) => driver.claim(1000, LEASE);

    /** The callbacks claimable now, as `[label, status]`. */
    const claimCallbacks = async (driver: QueueDriver) =>
      (await claimAll(driver))
        .filter((job) => job.name === "B")
        .map((job) => JSON.parse(job.args) as [string, BatchStatus]);

    test(
      "records every job of a batch, each claimable with its batch id",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 3, { name: "import:7" }));

        const claimed = await claimAll(driver);
        expect(claimed.map((job) => JSON.parse(job.args))).toEqual([[0], [1], [2]]);
        expect(claimed.every((job) => job.batchId === "batch-1" && job.name === "A")).toBe(true);
        expect(new Set(claimed.map((job) => job.id)).size).toBe(3);

        expect(await driver.findBatch!("batch-1")).toMatchObject({
          id: "batch-1",
          name: "import:7",
          total: 3,
          pending: 3,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          failedJobIds: [],
          progress: 0,
          cancelledAt: null,
          finishedAt: null,
        });
      }),
    );

    test(
      "a job dispatched on its own has no batch id",
      withDriver(async (driver) => {
        await driver.enqueue({ name: "A", args: "[]" });
        const [claimed] = await claimAll(driver);
        expect(claimed!.batchId).toBeUndefined();
      }),
    );

    test(
      "the last job to complete finishes the batch and enqueues then and finally, once",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 3, { callbacks }));
        const jobs = await claimAll(driver);

        await driver.complete(jobs[0]!);
        await driver.complete(jobs[1]!);
        expect(await claimCallbacks(driver)).toEqual([]);
        expect(await driver.findBatch!("batch-1")).toMatchObject({ pending: 1, succeeded: 2 });

        await driver.complete(jobs[2]!);
        // A stale report of the same claim changes nothing.
        await driver.complete(jobs[2]!);

        const calls = await claimCallbacks(driver);
        expect(calls.map(([label]) => label)).toEqual(["then", "finally"]);
        expect(calls[0]![1]).toMatchObject({
          id: "batch-1",
          total: 3,
          pending: 0,
          succeeded: 3,
          progress: 1,
        });
        expect(typeof calls[0]![1].finishedAt).toBe("number");
        expect(await driver.findBatch!("batch-1")).toMatchObject({ pending: 0, succeeded: 3 });
      }),
    );

    test(
      "concurrent completions finish the batch exactly once",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 12, { callbacks }));
        const jobs = await claimAll(driver);
        await Promise.all(jobs.map((job) => driver.complete(job)));

        expect((await claimCallbacks(driver)).map(([label]) => label)).toEqual(["then", "finally"]);
        expect(await driver.findBatch!("batch-1")).toMatchObject({ pending: 0, succeeded: 12 });
      }),
    );

    test(
      "a dead-letter fails the batch: catch at once, the waiting jobs cancelled, finally at the end",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 4, { callbacks }));
        const [first, second] = await driver.claim(2, LEASE);

        await driver.fail(first!, { error: "boom", retryInMs: null });

        // The two that were waiting are never handed out.
        const after = await claimAll(driver);
        expect(after.filter((job) => job.name === "A")).toEqual([]);
        expect(after.map((job) => JSON.parse(job.args)[0])).toEqual(["catch"]);
        expect(await driver.findBatch!("batch-1")).toMatchObject({
          pending: 1,
          failed: 1,
          cancelled: 2,
          failedJobIds: [first!.id],
        });
        expect((await driver.findBatch!("batch-1"))!.cancelledAt).toEqual(expect.any(Number));

        // The one still running finishes, and that ends the batch.
        await driver.complete(second!);
        const calls = await claimCallbacks(driver);
        expect(calls.map(([label]) => label)).toEqual(["finally"]);
        expect(calls[0]![1]).toMatchObject({ pending: 0, succeeded: 1, failed: 1, cancelled: 2 });
      }),
    );

    test(
      "with allowFailures a dead-letter leaves the rest running, and then still runs",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 3, { callbacks, allowFailures: true }));
        const jobs = await claimAll(driver);

        await driver.fail(jobs[0]!, { error: "boom", retryInMs: null });
        await driver.fail(jobs[1]!, { error: "boom again", retryInMs: null });
        expect((await claimCallbacks(driver)).map(([label]) => label)).toEqual(["catch"]);

        await driver.complete(jobs[2]!);
        const calls = await claimCallbacks(driver);
        expect(calls.map(([label]) => label)).toEqual(["then", "finally"]);
        expect(calls[1]![1]).toMatchObject({
          succeeded: 1,
          failed: 2,
          cancelled: 0,
          cancelledAt: null,
          failedJobIds: [jobs[0]!.id, jobs[1]!.id],
        });
      }),
    );

    test(
      "a retry is not counted, and starts its progress from 0",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 2));
        const [job] = await driver.claim(1, LEASE);

        await driver.reportProgress!(job!, 0.5);
        expect((await driver.findBatch!("batch-1"))!.progress).toBeCloseTo(0.25);

        await driver.fail(job!, { error: "flaky", retryInMs: 0 });
        expect(await driver.findBatch!("batch-1")).toMatchObject({ pending: 2, failed: 0, progress: 0 });

        const retried = (await claimAll(driver)).find((claimed) => claimed.id === job!.id);
        expect(retried).toMatchObject({ attempt: 2, batchId: "batch-1" });
      }),
    );

    test(
      "progress is the ended jobs plus what the running ones reported, over the total",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 4));
        const jobs = await claimAll(driver);

        await driver.complete(jobs[0]!);
        await driver.reportProgress!(jobs[1]!, 0.5);
        await driver.reportProgress!(jobs[2]!, 0.25);
        // A stale claim's report is ignored.
        await driver.reportProgress!({ ...jobs[3]!, attempt: 7 }, 1);

        expect((await driver.findBatch!("batch-1"))!.progress).toBeCloseTo((1 + 0.5 + 0.25) / 4);
        // Without the running jobs' share, when asked not to sum it.
        expect((await driver.findBatch!("batch-1", { progress: false }))!.progress).toBeCloseTo(
          1 / 4,
        );
      }),
    );

    test(
      "cancelBatch ends the waiting jobs, runs catch at once and finally once the running ones end",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 3, { callbacks }));
        const [running] = await driver.claim(1, LEASE);

        expect(await driver.cancelBatch!("batch-1")).toBe(true);
        expect(await driver.cancelBatch!("batch-1")).toBe(false);

        const after = await claimAll(driver);
        expect(after.map((job) => JSON.parse(job.args)[0])).toEqual(["catch"]);
        expect(await driver.findBatch!("batch-1")).toMatchObject({ pending: 1, cancelled: 2 });

        await driver.complete(running!);
        const calls = await claimCallbacks(driver);
        expect(calls.map(([label]) => label)).toEqual(["finally"]);
        expect(calls[0]![1]).toMatchObject({ pending: 0, succeeded: 1, cancelled: 2 });
        expect(await driver.cancelBatch!("batch-1")).toBe(false);
      }),
    );

    test(
      "a retry of a job whose batch was cancelled is ended as cancelled instead",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 1, { callbacks }));
        const [job] = await driver.claim(1, LEASE);
        await driver.cancelBatch!("batch-1");

        await driver.fail(job!, { error: "flaky", retryInMs: 0 });

        const after = await claimAll(driver);
        expect(after.filter((claimed) => claimed.name === "A")).toEqual([]);
        expect(after.map((claimed) => JSON.parse(claimed.args)[0])).toEqual(["catch", "finally"]);
        expect(await driver.findBatch!("batch-1")).toMatchObject({
          pending: 0,
          failed: 0,
          cancelled: 1,
        });
      }),
    );

    test(
      "a failure marked cancelled is counted as cancelled, not failed",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 1, { callbacks }));
        const [job] = await driver.claim(1, LEASE);

        await driver.fail(job!, { error: "cancelled", retryInMs: null, cancelled: true });

        expect(await driver.findBatch!("batch-1")).toMatchObject({
          pending: 0,
          failed: 0,
          cancelled: 1,
          failedJobIds: [],
        });
      }),
    );

    test(
      "a batch of no jobs is finished at once",
      withDriver(async (driver) => {
        await driver.enqueueBatch!(batchOf("batch-1", 0, { callbacks }));

        const calls = await claimCallbacks(driver);
        expect(calls.map(([label]) => label)).toEqual(["then", "finally"]);
        expect(await driver.findBatch!("batch-1")).toMatchObject({
          total: 0,
          pending: 0,
          progress: 1,
          finishedAt: expect.any(Number),
        });
      }),
    );

    test(
      "an unknown batch is null, and cannot be cancelled",
      withDriver(async (driver) => {
        expect(await driver.findBatch!("nope")).toBeNull();
        expect(await driver.cancelBatch!("nope")).toBe(false);
      }),
    );

    const transaction = features.transaction;
    if (transaction?.joins) {
      test(
        "a batch enqueued inside a transaction is claimable at the commit, and gone after a rollback",
        withDriver(async (driver) => {
          await transaction.run(driver, async () => {
            await driver.enqueueBatch!(batchOf("committed", 2));
            expect(await claimAll(driver)).toEqual([]);
          });
          expect(await claimAll(driver)).toHaveLength(2);

          await expect(
            transaction.run(driver, async () => {
              await driver.enqueueBatch!(batchOf("rolled-back", 2));
              throw new Error("rolled back");
            }),
          ).rejects.toThrow("rolled back");
          expect(await claimAll(driver)).toEqual([]);
          expect(await driver.findBatch!("rolled-back")).toBeNull();
        }),
      );
    }
  });
}
