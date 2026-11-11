import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DatabaseManager } from "../database/DatabaseManager";
import { Application } from "../foundation/Application";
import { SessionSettingConflictError } from "../orm/context";
import { Model } from "../orm/Model";
import { clearRegistry, register } from "../orm/registry";
import type { FieldSchema, ModelSchema } from "../orm/schema";
import { sql } from "../orm/sql";
import { DB } from "./DB";

/**
 * `DB.withSettings` (#1158): Postgres session settings, applied with
 * `set_config(name, value, true)` to every transaction in the block and to
 * single statements outside one.
 *
 * Postgres when `TEST_POSTGRES_URL` is set (CI's `queue-databases` job runs
 * the `postgres` suites), and the refusals on SQLite always.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

function useDatabase(config: ConstructorParameters<typeof DatabaseManager>[0]) {
  let previous: Application | undefined;
  let database: DatabaseManager;
  beforeAll(() => {
    database = new DatabaseManager(config);
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
  });
  afterAll(async () => {
    await database.close();
    if (previous) Application.setInstance(previous);
  });
}

const tenant = async () => {
  const [row] = await DB.query<{ tenant: string | null }>(
    sql`select current_setting('app.tenant_id', true) as tenant`,
  );
  return row!.tenant;
};

describe("DB.withSettings on sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemi-settings-"));
  useDatabase({ url: `sqlite://${join(dir, "db.sqlite")}` });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("is refused: Postgres only", async () => {
    await expect(DB.withSettings({ "app.tenant_id": "a" }, async () => 1)).rejects.toThrow(
      /Postgres only/,
    );
  });
});

describe("DB.withSettings on the servers this run has no URL for", () => {
  test.skipIf(!!POSTGRES_URL)("postgres did NOT run: set TEST_POSTGRES_URL", () => {
    console.warn("DB.withSettings: postgres did NOT run: set TEST_POSTGRES_URL");
  });
});

const view = `gemi_settings_${process.pid}`;
const scalar = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: true,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});
const schema: ModelSchema = {
  name: "SettingsProbe",
  table: view,
  fields: { id: scalar("id", { type: "Int", isId: true, nullable: false }), tenant: scalar("tenant") },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};
class SettingsProbe extends Model {
  static $schema = schema;
}

describe.skipIf(!POSTGRES_URL)("DB.withSettings on postgres", () => {
  // One connection, so "does it leak" asks the connection that ran it.
  useDatabase({ url: POSTGRES_URL!, options: { max: 1 } });

  beforeAll(async () => {
    register("SettingsProbe", SettingsProbe);
    await DB.sql.unsafe(
      `CREATE OR REPLACE VIEW ${view} AS SELECT 1 AS id, current_setting('app.tenant_id', true) AS tenant`,
    );
  });
  afterAll(async () => {
    clearRegistry();
    await DB.sql.unsafe(`DROP VIEW IF EXISTS ${view}`);
  });

  test("a single DB.query outside a transaction runs with the settings, and they don't leak", async () => {
    expect(await DB.withSettings({ "app.tenant_id": "t1" }, tenant)).toBe("t1");
    expect(await tenant()).toBeOneOf([null, ""]);
  });

  test("a single ORM call outside a transaction runs with them", async () => {
    const rows = await DB.withSettings({ "app.tenant_id": "t2" }, () =>
      SettingsProbe.$exec("findMany", {}),
    );
    expect(rows).toEqual([{ id: 1, tenant: "t2" }]);
    const outside = (await SettingsProbe.$exec("findMany", {})) as { tenant: string | null }[];
    expect(outside[0]!.tenant).toBeOneOf([null, ""]);
  });

  test("a transaction opened inside starts with them, savepoints included", async () => {
    const seen = await DB.withSettings({ "app.tenant_id": 7 }, () =>
      DB.transaction(async () => [await tenant(), await DB.transaction(tenant)]),
    );
    expect(seen).toEqual(["7", "7"]);
  });

  test("entered inside an open transaction: applied now, reset when the block returns", async () => {
    const seen = await DB.transaction(async () => {
      const before = await tenant();
      const inside = await DB.withSettings({ "app.tenant_id": "t3" }, tenant);
      return [before, inside, await tenant()];
    });
    expect(seen[0]).toBeOneOf([null, ""]);
    expect(seen.slice(1)).toEqual(["t3", ""]);
  });

  test("blocks nest and add settings; changing an outer one is refused", async () => {
    const both = await DB.withSettings({ "app.tenant_id": "a" }, () =>
      DB.withSettings({ "app.user_id": 5 }, async () => {
        const [row] = await DB.query<{ t: string; u: string }>(
          sql`select current_setting('app.tenant_id') as t, current_setting('app.user_id') as u`,
        );
        return row;
      }),
    );
    expect(both).toEqual({ t: "a", u: "5" });

    await expect(
      DB.withSettings({ "app.tenant_id": "a" }, () =>
        DB.withSettings({ "app.tenant_id": "b" }, tenant),
      ),
    ).rejects.toBeInstanceOf(SessionSettingConflictError);
    // The same value again is fine.
    expect(
      await DB.withSettings({ "app.tenant_id": "a" }, () =>
        DB.withSettings({ "app.tenant_id": "a" }, tenant),
      ),
    ).toBe("a");
  });

  test("DB.readOnly applies them after SET TRANSACTION", async () => {
    expect(await DB.withSettings({ "app.tenant_id": "ro" }, () => DB.readOnly(tenant))).toBe("ro");
  });

  test("a name without a prefix is refused before anything runs", async () => {
    await expect(DB.withSettings({ tenant: "x" }, tenant)).rejects.toThrow(/custom setting name/);
  });
});
