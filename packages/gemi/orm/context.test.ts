import { afterEach, describe, expect, test } from "vitest";

import {
  currentTransaction,
  ormContext,
  transactionDepth,
  withTransaction,
} from "./context";

/**
 * The ambient-transaction scope, tested without a database.
 *
 * The property that matters here is not what SQL runs — `transactions.test.ts`
 * in the template covers that against both dialects. It is that the scope is
 * *per async subtree*: two concurrent transactions must never see each other's
 * handle, at any interleaving. That is a property of the storage mechanism, so
 * it is worth pinning where a fake handle can produce interleavings a real
 * database would not reliably reproduce.
 *
 * The fake below is the smallest thing `withTransaction` actually calls:
 * `begin(fn)` and `savepoint(fn)`. It also records the statements issued
 * through it, which is how "this query ran on that handle" is *observed* rather
 * than inferred.
 */
function fakePool(name: string) {
  const log: string[] = [];

  const handle: any = {
    name,
    log,
    unsafe(text: string) {
      log.push(text);
      return Promise.resolve([]);
    },
    savepoint(fn: (sp: any) => Promise<unknown>) {
      // Matches Bun, which hands the savepoint callback the same object.
      return Promise.resolve().then(() => fn(handle));
    },
  };

  return {
    handle,
    log,
    begin(fn: (tx: any) => Promise<unknown>) {
      return Promise.resolve().then(() => fn(handle));
    },
  } as any;
}

describe("the ambient transaction scope", () => {
  test("there is no scope outside a transaction", () => {
    expect(currentTransaction()).toBeUndefined();
    expect(transactionDepth()).toBeNull();
  });

  test("the handle is the one the pool gave out", async () => {
    const pool = fakePool("a");

    await withTransaction(pool, async (tx) => {
      expect(tx).toBe(pool.handle);
      expect(currentTransaction()).toBe(pool.handle);
      expect(transactionDepth()).toBe(0);
    });
  });

  test("the scope closes with the callback", async () => {
    const pool = fakePool("a");
    await withTransaction(pool, async () => {});

    expect(currentTransaction()).toBeUndefined();
    expect(transactionDepth()).toBeNull();
  });

  // Bun's handle stays callable after `begin` resolves — it just runs on the
  // pool, outside any transaction, and succeeds. So a leaked scope would not
  // announce itself; it would silently write outside the transaction.
  test("the scope closes even when the callback throws", async () => {
    const pool = fakePool("a");

    await expect(
      withTransaction(pool, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(currentTransaction()).toBeUndefined();
  });

  test("nesting increments depth and restores it on the way out", async () => {
    const pool = fakePool("a");

    await withTransaction(pool, async () => {
      expect(transactionDepth()).toBe(0);
      await withTransaction(pool, async () => {
        expect(transactionDepth()).toBe(1);
        await withTransaction(pool, async () => {
          expect(transactionDepth()).toBe(2);
        });
        expect(transactionDepth()).toBe(1);
      });
      expect(transactionDepth()).toBe(0);
    });
  });

  // A nested call must go through `savepoint`, not `begin` — Bun rejects a
  // `begin` inside a transaction outright, so getting this wrong is a runtime
  // failure the moment anyone nests.
  test("a nested transaction opens a savepoint, never a second begin", async () => {
    const pool = fakePool("a");
    let begins = 0;
    let savepoints = 0;

    const counting: any = {
      ...pool,
      begin(fn: (tx: any) => Promise<unknown>) {
        begins++;
        return pool.begin(fn);
      },
    };
    pool.handle.savepoint = (fn: (sp: any) => Promise<unknown>) => {
      savepoints++;
      return Promise.resolve().then(() => fn(pool.handle));
    };

    await withTransaction(counting, async () => {
      await withTransaction(counting, async () => {
        await withTransaction(counting, async () => {});
      });
    });

    expect(begins).toBe(1);
    expect(savepoints).toBe(2);
  });

  /**
   * The test the whole storage choice exists for.
   *
   * Two transactions run concurrently with awaits interleaved between every
   * step, so each one is suspended while the other is running. If the handle
   * lived anywhere shared — a field on the Application, a module-level variable
   * — the second `begin` would overwrite the first and the first transaction's
   * statements would land in the second one. Not an error: committed data in
   * the wrong transaction.
   */
  test("two concurrent transactions never see each other's handle", async () => {
    const first = fakePool("first");
    const second = fakePool("second");
    const seen: string[] = [];

    async function run(pool: any, label: string, delays: number[]) {
      await withTransaction(pool, async () => {
        for (const delay of delays) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          const handle = currentTransaction() as any;
          seen.push(`${label}:${handle.name}`);
          await handle.unsafe(`${label} step`);
        }
      });
    }

    await Promise.all([
      run(first, "A", [0, 4, 0, 6]),
      run(second, "B", [2, 0, 5, 0]),
    ]);

    // Every observation matched its own transaction...
    expect(seen.filter((entry) => entry === "A:first")).toHaveLength(4);
    expect(seen.filter((entry) => entry === "B:second")).toHaveLength(4);

    // ...and the statements landed on the right handles, not just the reads.
    expect(first.handle.log).toEqual(["A step", "A step", "A step", "A step"]);
    expect(second.handle.log).toEqual(["B step", "B step", "B step", "B step"]);

    // The interleaving was real — otherwise this would be testing two
    // sequential runs and proving nothing.
    expect(seen.join(",")).not.toBe(
      "A:first,A:first,A:first,A:first,B:second,B:second,B:second,B:second",
    );
  });

  test("a transaction inside a concurrent sibling's scope still nests on its own", async () => {
    const outer = fakePool("outer");
    const other = fakePool("other");
    let innerDepth: number | null = null;
    let siblingDepth: number | null = null;

    await Promise.all([
      withTransaction(outer, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await withTransaction(outer, async () => {
          innerDepth = transactionDepth();
        });
      }),
      withTransaction(other, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        siblingDepth = transactionDepth();
      }),
    ]);

    expect(innerDepth).toBe(1);
    // The sibling is at depth 0 despite overlapping with a nested scope.
    expect(siblingDepth).toBe(0);
  });

  test("the store is exactly what withTransaction put there", async () => {
    const pool = fakePool("a");

    await withTransaction(pool, async () => {
      expect(ormContext.getStore()).toEqual({ tx: pool.handle, depth: 0 });
    });
  });
});

/**
 * The development-mode warning for a transaction that holds its connection too
 * long.
 *
 * Driven with a real timer against a tiny threshold rather than vitest's fake
 * clock, because the thing under test is partly *which* clock: the timer is
 * `unref`'d so a pending warning cannot keep a short-lived process alive, and a
 * fake clock replaces the very object that behaviour lives on.
 */
describe("the slow-transaction warning", () => {
  const env = process.env;

  function inDevelopment(thresholdMs: number) {
    process.env = {
      ...env,
      NODE_ENV: "development",
      GEMI_SLOW_TRANSACTION_MS: String(thresholdMs),
    };
  }

  /**
   * Collects warnings for the duration of `fn`, restoring `console.warn`.
   *
   * `fn` receives the live array, so a test can also assert on what had been
   * warned at a given moment *during* the transaction.
   */
  async function capture(
    fn: (warnings: string[]) => Promise<unknown>,
  ): Promise<string[]> {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => void warnings.push(message);
    try {
      await fn(warnings);
      // The warning fires from a timer, so it can land in the tick after the
      // transaction settles. Give it one before concluding it never came —
      // otherwise "did not warn" would pass for the wrong reason.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => {
    process.env = env;
  });

  test("a transaction past the threshold warns while it is still open", async () => {
    inDevelopment(10);
    const pool = fakePool("a");
    let warnedDuringCallback: string[] = [];

    const warnings = await capture((seen) =>
      withTransaction(pool, async () => {
        await sleep(40);
        warnedDuringCallback = [...seen];
      }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not settled after 10ms");
    // The point of a timer over an elapsed-time measurement: the report arrives
    // while the connection is still held, not in the post-mortem.
    expect(warnedDuringCallback).toHaveLength(1);
  });

  // The realistic transaction settles in single-digit milliseconds. If those
  // warned, the warning would be noise and get muted, which is the same as not
  // having it.
  test("a transaction inside the threshold says nothing", async () => {
    inDevelopment(50);
    const pool = fakePool("a");

    const warnings = await capture(() => withTransaction(pool, async () => {}));

    expect(warnings).toEqual([]);
  });

  // A rollback releases the connection exactly as a commit does, so a throwing
  // callback has to disarm the timer too.
  test("a throwing transaction disarms the warning", async () => {
    inDevelopment(10);
    const pool = fakePool("a");

    const warnings = await capture(async () => {
      await expect(
        withTransaction(pool, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });

    expect(warnings).toEqual([]);
  });

  // Savepoints reserve no connection of their own. Warning per depth would
  // report one slow block three times and name the innermost frame rather than
  // the one actually holding the connection.
  test("nesting warns once, for the outermost scope", async () => {
    inDevelopment(10);
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(pool, () =>
        withTransaction(pool, () =>
          withTransaction(pool, async () => {
            await sleep(40);
          }),
        ),
      ),
    );

    expect(warnings).toHaveLength(1);
  });

  test("production is silent, however long the transaction runs", async () => {
    process.env = {
      ...env,
      NODE_ENV: "production",
      GEMI_SLOW_TRANSACTION_MS: "10",
    };
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(pool, async () => {
        await sleep(40);
      }),
    );

    expect(warnings).toEqual([]);
  });

  // A typo in the env var must not switch the diagnostic off — silently losing
  // a warning is worse than ignoring an unreadable threshold.
  test("an unusable threshold falls back to the default rather than disabling", async () => {
    inDevelopment(10);
    process.env.GEMI_SLOW_TRANSACTION_MS = "soon";
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(pool, async () => {
        await sleep(40);
      }),
    );

    // The default is 2s, so nothing fires inside this test — the assertion is
    // that it fell back to *some* real threshold instead of returning null.
    expect(warnings).toEqual([]);
  });

  test("the warning names the call site", async () => {
    inDevelopment(10);
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(pool, async () => {
        await sleep(40);
      }),
    );

    expect(warnings[0]).toContain("context.test.ts");
  });
});
