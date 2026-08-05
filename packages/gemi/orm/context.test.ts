import { afterEach, describe, expect, test } from "vitest";

import { SLOW_TRANSACTION_THRESHOLD } from "../database/config";
import { CrossConnectionTransactionError } from "../database/Connection";
import {
  assertConnectionUsable,
  currentConnectionName,
  currentTransaction,
  isSystemScope,
  ormContext,
  runAsSystem,
  runOnConnection,
  slowTransactionThreshold,
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

  /**
   * The threshold is config now, so it is passed to `withTransaction` rather
   * than set in the environment. Only `NODE_ENV` is still ambient — the
   * warning is development-only regardless of what the config says.
   */
  const THRESHOLD = 10;
  const options = { slowTransactionThreshold: THRESHOLD };

  function inDevelopment() {
    process.env = { ...env, NODE_ENV: "development" };
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

  /**
   * How long a "this should warn" test stays inside its transaction.
   *
   * 20× the 10ms threshold. The obvious 4× is enough on an idle machine and
   * thinner than it looks on a loaded CI box running the suite in parallel,
   * where the timer competes with every other worker for the event loop. The
   * headroom costs a fraction of a second across the whole file and removes the
   * only source of flake here.
   */
  const PAST_THRESHOLD = 200;

  afterEach(() => {
    process.env = env;
  });

  test("a transaction past the threshold warns while it is still open", async () => {
    inDevelopment();
    const pool = fakePool("a");
    let warnedDuringCallback: string[] = [];

    const warnings = await capture((seen) =>
      withTransaction(
        pool,
        async () => {
          await sleep(PAST_THRESHOLD);
          warnedDuringCallback = [...seen];
        },
        options,
      ),
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
    inDevelopment();
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(pool, async () => {}, { slowTransactionThreshold: 50 }),
    );

    expect(warnings).toEqual([]);
  });

  // A rollback releases the connection exactly as a commit does, so a throwing
  // callback has to disarm the timer too.
  test("a throwing transaction disarms the warning", async () => {
    inDevelopment();
    const pool = fakePool("a");

    const warnings = await capture(async () => {
      await expect(
        withTransaction(
          pool,
          async () => {
            throw new Error("boom");
          },
          options,
        ),
      ).rejects.toThrow("boom");
    });

    expect(warnings).toEqual([]);
  });

  // Savepoints reserve no connection of their own. Warning per depth would
  // report one slow block three times and name the innermost frame rather than
  // the one actually holding the connection.
  test("nesting warns once, for the outermost scope", async () => {
    inDevelopment();
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(
        pool,
        () =>
          withTransaction(
            pool,
            () =>
              withTransaction(
                pool,
                async () => {
                  await sleep(PAST_THRESHOLD);
                },
                options,
              ),
            options,
          ),
        options,
      ),
    );

    expect(warnings).toHaveLength(1);
  });

  test("production is silent, however long the transaction runs", async () => {
    process.env = { ...env, NODE_ENV: "production" };
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(
        pool,
        async () => {
          await sleep(PAST_THRESHOLD);
        },
        options,
      ),
    );

    expect(warnings).toEqual([]);
  });

  // A synchronous throw from `begin` — a closed pool — never reaches the
  // `.finally`, because there is no promise to attach it to. Without the
  // `try`/`catch` the timer stays armed and warns about a transaction that
  // never opened.
  test("a pool that throws synchronously disarms the warning", async () => {
    inDevelopment();
    const pool: any = {
      begin() {
        throw new Error("pool is closed");
      },
    };

    const warnings = await capture(async () => {
      expect(() => withTransaction(pool, async () => {}, options)).toThrow(
        "pool is closed",
      );
      await sleep(PAST_THRESHOLD);
    });

    expect(warnings).toEqual([]);
  });

  test("the warning names the call site", async () => {
    inDevelopment();
    const pool = fakePool("a");

    const warnings = await capture(() =>
      withTransaction(
        pool,
        async () => {
          await sleep(PAST_THRESHOLD);
        },
        options,
      ),
    );

    expect(warnings[0]).toContain("context.test.ts");
  });

  /**
   * The `unref` is the stated reason this file uses a real clock instead of
   * vitest's fake one, so it has to be asserted somewhere or the justification
   * is unbacked — deleting the call would otherwise pass the whole suite.
   *
   * A pending warning that kept the event loop alive would turn a diagnostic
   * into a hang: `gemi db:seed` finishing its work and then sitting there for
   * the remainder of a two-second threshold, for a transaction that already
   * committed.
   */
  test("the warning timer does not hold the process open", async () => {
    inDevelopment();
    const pool = fakePool("a");
    const realSetTimeout = globalThis.setTimeout;
    const unreffed: boolean[] = [];

    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const timer = realSetTimeout(fn, ms);
      const realUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unreffed.push(true);
        return realUnref ? realUnref() : timer;
      };
      return timer;
    }) as typeof globalThis.setTimeout;

    try {
      await withTransaction(pool, async () => {}, options);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(unreffed).toEqual([true]);
  });
});

/**
 * The threshold itself, asserted as a value rather than through the warning.
 *
 * The fallback — a malformed `database.slowTransactionThreshold` landing on the
 * default instead of switching the warning off — cannot be tested behaviourally
 * at all. "No warning fired" is what you observe when the fallback works (the
 * default is 2s, longer than any sane test) *and* when it is missing entirely,
 * so a behavioural test of it passes under the very mutation it is meant to
 * catch. Reading the number is the only version that can fail.
 */
describe("the slow-transaction threshold", () => {
  const env = process.env;

  function inMode(nodeEnv: string) {
    process.env = { ...env, NODE_ENV: nodeEnv };
  }

  afterEach(() => {
    process.env = env;
  });

  test("the warning is off outside development", () => {
    for (const nodeEnv of ["production", "test", ""]) {
      inMode(nodeEnv);
      expect(slowTransactionThreshold(10)).toBeNull();
    }
  });

  test("unconfigured means the two-second default", () => {
    inMode("development");
    expect(slowTransactionThreshold()).toBe(SLOW_TRANSACTION_THRESHOLD);
    expect(slowTransactionThreshold()).toBe(2_000);
  });

  test("a usable value is honoured", () => {
    inMode("development");
    expect(slowTransactionThreshold(500)).toBe(500);
  });

  /**
   * `false` is the only off-switch, and the reason the config type is
   * `number | false` rather than just `number`.
   *
   * Under the old env var there was no way to say "off" that a typo could not
   * also say by accident. Now the two are different shapes: anything malformed
   * falls back, and only the literal `false` disables.
   */
  test("false is the off switch", () => {
    inMode("development");
    expect(slowTransactionThreshold(false)).toBeNull();
  });

  /**
   * Every one of these falls back rather than returning `null`.
   *
   * Silently losing a diagnostic to a bad value is worse than ignoring the bad
   * value: the warning would simply stop appearing, and nothing would say why.
   * Note `Infinity` — finite-looking to a reader, and the reason the check is
   * `Number.isFinite` rather than `!Number.isNaN`; without it the timer would
   * be scheduled for never.
   */
  test.each([
    ["zero", 0],
    ["negative", -1],
    ["infinite", Infinity],
    ["negative infinite", -Infinity],
    ["not a number", NaN],
  ])("%s falls back to the default", (_label, configured) => {
    inMode("development");
    expect(slowTransactionThreshold(configured)).toBe(2_000);
  });
});

/**
 * Which connection the scope is on, and what happens when a statement names
 * another one while a transaction is open (#327).
 *
 * Tested here, with fake pools, for the same reason the handle is: the
 * behaviour worth pinning is a property of the *scope*, and a fake pool can
 * produce the case that matters — one transaction open on A, a statement
 * naming B — without needing two real databases to prove that no SQL ran. The
 * end-to-end half, where the two connections are two files and the rows are the
 * evidence, is the template's `connections.test.ts`.
 */
describe("the ambient connection", () => {
  test("outside any scope it is the default one", () => {
    expect(currentConnectionName()).toBe("default");
  });

  test("a named transaction puts its connection in scope, and takes it out again", async () => {
    const pool = fakePool("analytics");

    await withTransaction(pool, async () => {
      expect(currentConnectionName()).toBe("analytics");
    }, { connection: "analytics" });

    expect(currentConnectionName()).toBe("default");
  });

  /**
   * The reason an unqualified query inherits rather than defaulting. Inside
   * `DB.connection("analytics").transaction(...)`, a bare `User.create` has to
   * join the open transaction — resolving it to the *default* connection
   * instead would refuse it, and refusing the ordinary case would make the
   * whole handle unusable.
   */
  test("an unqualified statement inside one is not refused by it", async () => {
    const pool = fakePool("analytics");

    await withTransaction(pool, async () => {
      expect(() => assertConnectionUsable(currentConnectionName())).not.toThrow();
    }, { connection: "analytics" });
  });

  test("naming the same connection again is a savepoint, not a refusal", async () => {
    const pool = fakePool("analytics");

    await withTransaction(pool, async () => {
      await withTransaction(pool, async () => {
        expect(transactionDepth()).toBe(1);
      }, { connection: "analytics" });
    }, { connection: "analytics" });
  });

  /**
   * The failure the whole feature turns on. Before the check, this took a
   * savepoint on the *open* handle and ran the callback against it — so
   * statements meant for one database landed in another, with no error and
   * usually with tables of the same shape to land in.
   */
  test("a transaction on another connection is refused, not savepointed", async () => {
    const hot = fakePool("default");
    const analytics = fakePool("analytics");

    await withTransaction(hot, async () => {
      // Synchronously, before `begin` — this function already throws that way
      // for a closed pool, and the public doors (`Model.transaction`,
      // `DB.connection(name).transaction`) are `async`, so what an application
      // sees is a rejection either way.
      expect(() =>
        withTransaction(analytics, async () => "unreachable", {
          connection: "analytics",
        }),
      ).toThrow(CrossConnectionTransactionError);

      // Nothing was issued on either handle, which is the half that says it
      // refused rather than ran and rolled back.
      expect(analytics.log).toEqual([]);
      expect(hot.log).toEqual([]);
    }, { connection: "default" });
  });

  test("a statement naming another connection is refused too", async () => {
    const hot = fakePool("default");

    await withTransaction(hot, async () => {
      expect(() => assertConnectionUsable("analytics")).toThrow(
        CrossConnectionTransactionError,
      );
    });
  });

  /**
   * Outside a transaction there is nothing to straddle, so naming a connection
   * is always allowed — which is what makes `Model.on("analytics")` free in the
   * ordinary case rather than something to be justified.
   */
  test("outside a transaction any connection may be named", () => {
    expect(() => assertConnectionUsable("analytics")).not.toThrow();
    expect(() => assertConnectionUsable("default")).not.toThrow();
  });

  test("entering a connection merges the scope rather than replacing it", async () => {
    const pool = fakePool("default");

    await runAsSystem(async () => {
      await withTransaction(pool, async (tx) => {
        await runOnConnection("analytics", async () => {
          // The transaction handle and the suspended policies both survive
          // naming a connection — the same rule `asSystem` and `asUser` follow,
          // and the one that would otherwise drop an open handle.
          expect(currentConnectionName()).toBe("analytics");
          expect(currentTransaction()).toBe(tx);
          expect(isSystemScope()).toBe(true);
        });
      });
    });
  });

  /**
   * `$exec` calls this on every operation, so the no-op case is the hot one:
   * re-entering the connection already in scope must not cost a second store.
   */
  test("naming the connection already in scope enters nothing", async () => {
    await runOnConnection("analytics", async () => {
      const store = ormContext.getStore();
      await runOnConnection("analytics", async () => {
        expect(ormContext.getStore()).toBe(store);
      });
    });
  });

  test("the default connection is spelled as an absent name, not as a scope", async () => {
    await runOnConnection("default", async () => {
      // Nothing was entered, so an application with one connection pays
      // nothing for this feature at all.
      expect(ormContext.getStore()).toBeUndefined();
      expect(currentConnectionName()).toBe("default");
    });
  });
});
