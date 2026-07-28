import { describe, expect, test } from "vitest";

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
