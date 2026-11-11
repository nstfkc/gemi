import { describe, expect, test } from "vitest";
import {
  applyTransactionSettings,
  currentSettings,
  runWithSettings,
  SessionSettingConflictError,
  withTransaction,
} from "./context";

/**
 * Session settings (#1158), against a fake pool that records statements. The
 * Postgres round trip is `facades/DB.withSettings.test.ts`.
 */

function fakePool() {
  const log: [string, unknown[]][] = [];
  const handle: any = {
    unsafe(text: string, values: unknown[] = []) {
      log.push([text, values]);
      return Promise.resolve([]);
    },
    savepoint(fn: (sp: any) => Promise<unknown>) {
      return Promise.resolve().then(() => fn(handle));
    },
  };
  return { log, begin: (fn: (tx: any) => Promise<unknown>) => Promise.resolve().then(() => fn(handle)) } as any;
}

describe("session settings (#1158)", () => {
  test("a transaction opened in a block starts with set_config for each, once", async () => {
    const pool = fakePool();
    await runWithSettings({ "app.tenant_id": "t", "app.user_id": 5 }, () =>
      withTransaction(pool, async () => {
        await withTransaction(pool, async () => {});
      }),
    );
    expect(pool.log).toEqual([
      ["select set_config($1, $2, true), set_config($3, $4, true)", ["app.tenant_id", "t", "app.user_id", "5"]],
    ]);
  });

  test("no block, no statement", async () => {
    const pool = fakePool();
    await withTransaction(pool, async () => {});
    expect(pool.log).toEqual([]);
    expect(currentSettings()).toBeUndefined();
  });

  test("inside an open transaction: applied now and reset when the block returns", async () => {
    const pool = fakePool();
    await withTransaction(pool, () =>
      runWithSettings({ "app.tenant_id": "t" }, async () => {
        expect(currentSettings()).toEqual({ "app.tenant_id": "t" });
      }),
    );
    expect(pool.log).toEqual([
      ["select set_config($1, $2, true)", ["app.tenant_id", "t"]],
      ["select set_config($1, '', true)", ["app.tenant_id"]],
    ]);
  });

  test("deferred settings are applied when the caller says", async () => {
    const pool = fakePool();
    await runWithSettings({ "app.tenant_id": "t" }, () =>
      withTransaction(
        pool,
        async (tx) => {
          await tx.unsafe("SET TRANSACTION READ ONLY");
          await applyTransactionSettings();
        },
        { deferSettings: true },
      ),
    );
    expect(pool.log.map(([text]) => text)).toEqual([
      "SET TRANSACTION READ ONLY",
      "select set_config($1, $2, true)",
    ]);
  });

  test("a nested block may add settings but not change one", async () => {
    await runWithSettings({ "app.tenant_id": "a" }, async () => {
      await runWithSettings({ "app.user_id": null }, async () => {
        expect(currentSettings()).toEqual({ "app.tenant_id": "a", "app.user_id": "" });
      });
      await expect(runWithSettings({ "app.tenant_id": "b" }, async () => {})).rejects.toBeInstanceOf(
        SessionSettingConflictError,
      );
    });
  });
});
