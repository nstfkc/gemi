import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  UniqueConstraintError,
  clearPlanCache,
  register,
  type ModelSchema,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * `createMany` past the driver's parameter ceiling.
 *
 * Iteration 4 refused to chunk, and named its own unblocking condition:
 *
 * > **No automatic chunking.** Prisma splits a large `createMany`; gemi raises
 * > `ParameterLimitError`… Chunking means several statements, which cannot be
 * > made atomic before iteration 5.
 *
 * So the interesting assertion is not "all the rows arrive" — it is **what
 * happens when the second statement fails.** Several statements that are not
 * atomic would leave the first chunk written, which is a worse answer than the
 * error this used to raise.
 *
 * Twelve columns per row so the SQLite ceiling (32 766) is reached at ~2 730
 * rows rather than ~5 500, which keeps the suite quick. SQLite only: the
 * ceiling is a property of the driver, both dialects have one, and inserting
 * tens of thousands of parameters over a socket to prove the same branch twice
 * is not worth the wall clock.
 */

const COLUMNS = Array.from({ length: 11 }, (_, i) => `c${i}`);

const DDL = [
  `DROP TABLE IF EXISTS "Wide"`,
  `CREATE TABLE "Wide" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "tag" TEXT NOT NULL UNIQUE,
     ${COLUMNS.map((name) => `"${name}" TEXT NOT NULL`).join(",\n     ")}
   )`,
];

function field(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    column: name,
    type: "String",
    nullable: false,
    isId: false,
    isUpdatedAt: false,
    ...extra,
  } as any;
}

const wide: ModelSchema = {
  name: "Wide",
  table: "Wide",
  fields: {
    id: {
      ...field("id"),
      type: "Int",
      isId: true,
      default: { kind: "autoincrement" },
    },
    tag: field("tag"),
    ...Object.fromEntries(COLUMNS.map((name) => [name, field(name)])),
  },
  primaryKey: ["id"],
  uniques: [["tag"]],
  relations: {},
};

class Wide extends Model {
  static $schema = wide;
}

/** 12 bound parameters per row: `tag` plus the eleven `c` columns. */
const PER_ROW = COLUMNS.length + 1;
const SQLITE_LIMIT = 32766;
const PER_CHUNK = Math.floor(SQLITE_LIMIT / PER_ROW);

function rows(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    tag: `row-${from + i}`,
    ...Object.fromEntries(COLUMNS.map((name) => [name, `${name}-${from + i}`])),
  }));
}

describe("createMany over the parameter ceiling — sqlite", () => {
  let workspace: string;
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-orm-chunk-"));
    const url = `sqlite://${join(workspace, "chunk.db")}`;

    database = new DatabaseManager({ url });
    raw = new SQL(url);
    for (const statement of DDL) await raw.unsafe(statement);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);

    register("Wide", Wide);
  }, 120_000);

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS "Wide"`).catch(() => {});
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(`DELETE FROM "Wide"`);
  });

  const count = () =>
    Model.asSystem(() => Wide.$exec("count", {})) as Promise<number>;

  /** One statement's worth still goes as one statement. */
  test("a createMany under the ceiling is untouched", async () => {
    const result: any = await Model.asSystem(() =>
      Wide.$exec("createMany", { data: rows(PER_CHUNK) }),
    );

    expect(result).toEqual({ count: PER_CHUNK });
    expect(await count()).toBe(PER_CHUNK);
  });

  test("one row over the ceiling writes every row and reports one count", async () => {
    const total = PER_CHUNK + 1;
    const result: any = await Model.asSystem(() =>
      Wide.$exec("createMany", { data: rows(total) }),
    );

    expect(result).toEqual({ count: total });
    expect(await count()).toBe(total);
  });

  test("several chunks", async () => {
    const total = PER_CHUNK * 2 + 7;
    const result: any = await Model.asSystem(() =>
      Wide.$exec("createMany", { data: rows(total) }),
    );

    expect(result).toEqual({ count: total });
    expect(await count()).toBe(total);
  });

  /**
   * The assertion iteration 4 was waiting for. A chunked write is several
   * statements, and several statements that are not atomic are worse than the
   * refusal this replaced — the caller would be left holding a partial insert
   * with a successful-looking error.
   *
   * The duplicate is placed in the *second* chunk on purpose, so the first has
   * already been written by the time the failure happens.
   */
  test("a failure in a later chunk rolls the earlier ones back", async () => {
    const total = PER_CHUNK * 2;
    const data = rows(total);
    data[PER_CHUNK + 10] = { ...data[0] };

    await expect(
      Model.asSystem(() => Wide.$exec("createMany", { data })),
    ).rejects.toThrow(UniqueConstraintError);

    expect(await count()).toBe(0);
  });

  /**
   * Inside a caller's transaction the chunks become a savepoint, and rolling the
   * outer one back has to take them with it — otherwise the atomicity above
   * holds only when nobody else is using a transaction.
   */
  test("it rolls back with an enclosing transaction", async () => {
    const total = PER_CHUNK + 5;

    await expect(
      Model.asSystem(() =>
        Model.transaction(async () => {
          const result: any = await Wide.$exec("createMany", {
            data: rows(total),
          });
          expect(result.count).toBe(total);
          throw new Error("rollback");
        }),
      ),
    ).rejects.toThrow("rollback");

    expect(await count()).toBe(0);
  });
});
