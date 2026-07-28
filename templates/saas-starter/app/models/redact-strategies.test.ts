import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  clearPlanCache,
  register,
  type ModelPolicy,
  type ModelSchema,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./differential";

/**
 * `redact` on a **nested** model, under both relation strategies.
 *
 * Iteration 9 established that a policy's `scope` survives the lateral fold,
 * because policies rewrite the *argument tree* before planning and the scoped
 * `where` lands inside the subquery. `redact` cannot work that way: it is a row
 * transform in the shaping stage, not an argument. So the question it answers
 * for `scope` has to be asked again, separately, and the answer is not implied
 * by the first one.
 *
 * Under the batched strategy a child row is shaped by the child model's own
 * `$exec`, which runs its `redact` on the way out. **Under lateral there is no
 * such call** — the child's rows arrive inside the parent's statement — so the
 * only thing that could redact them is the parent's own pass, and that runs the
 * *parent's* policies over the parent's rows.
 *
 * Postgres only, because lateral is Postgres-only, and it is the default there:
 * if these disagree, the divergence is on by default in production and off in a
 * SQLite development environment.
 */

const DDL = [
  `DROP TABLE IF EXISTS "Ledger"`,
  `DROP TABLE IF EXISTS "Book"`,
  `CREATE TABLE "Book" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "title" TEXT NOT NULL
   )`,
  `CREATE TABLE "Ledger" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "bookId" INTEGER NOT NULL REFERENCES "Book"("id"),
     "label" TEXT NOT NULL,
     "secret" TEXT
   )`,
];

function field(name: string, type: any, extra: Record<string, unknown> = {}) {
  return {
    name,
    column: name,
    type,
    nullable: false,
    isId: false,
    isUpdatedAt: false,
    ...extra,
  } as any;
}

const bookSchema: ModelSchema = {
  name: "Book",
  table: "Book",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    title: field("title", "String"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    ledgers: {
      name: "ledgers",
      model: "Ledger",
      kind: "many",
      relationName: "BookToLedger",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const ledgerSchema: ModelSchema = {
  name: "Ledger",
  table: "Ledger",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    bookId: field("bookId", "Int"),
    label: field("label", "String"),
    // Nullable, because `redactNullable` refuses to null a field the generated
    // type says is always there.
    secret: field("secret", "String", { nullable: true }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    book: {
      name: "book",
      model: "Book",
      kind: "one",
      relationName: "BookToLedger",
      from: ["bookId"],
      to: ["id"],
      nullable: false,
    },
  },
};

const hideSecret: ModelPolicy = {
  redact: (_context, row) => {
    if ("secret" in row) row.secret = null;
  },
};

class Book extends Model {
  static $schema = bookSchema;
}

class Ledger extends Model {
  static $schema = ledgerSchema;
  static $policy = hideSecret;
}

const RUN = POSTGRES_URL ? describe : describe.skip;

RUN("redact on a nested model, both strategies", () => {
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    database = new DatabaseManager({ url: POSTGRES_URL! });
    raw = new SQL(POSTGRES_URL!);
    for (const statement of DDL) await raw.unsafe(statement);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);

    register("Book", Book);
    register("Ledger", Ledger);
  }, 120_000);

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS "Ledger"`).catch(() => {});
    await raw?.unsafe(`DROP TABLE IF EXISTS "Book"`).catch(() => {});
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(`TRUNCATE "Ledger", "Book" RESTART IDENTITY CASCADE`);
    await raw.unsafe(`INSERT INTO "Book" ("title") VALUES ('ours')`);
    await raw.unsafe(
      `INSERT INTO "Ledger" ("bookId", "label", "secret")
       VALUES (1, 'a', 'classified'), (1, 'b', 'classified')`,
    );
  });

  // `asUser`, not `asSystem`. `asSystem` suspends policies for the whole
  // subtree — which is the correct behaviour and made the first version of this
  // file report a redaction hole that was not there. A test for a policy cannot
  // run in the scope that turns policies off.
  const READER = { id: 1 };

  async function bothStrategies(args: any) {
    const batched = (await Model.asUser(READER, () =>
      Book.$exec("findMany", args, { strategy: "batched" } as never),
    )) as any[];
    const lateral = (await Model.asUser(READER, () =>
      Book.$exec("findMany", args, { strategy: "lateral" } as never),
    )) as any[];
    return { batched, lateral };
  }

  /** A root read is redacted under either strategy — nothing folds. */
  test("the child's own query is redacted", async () => {
    const rows = (await Model.asUser(READER, () =>
      Ledger.$exec("findMany", {}),
    )) as any[];

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.secret).toBeNull();
  });

  /**
   * The case this file exists for. Under batched the child's `$exec` redacts on
   * the way out; under lateral there is no such call.
   */
  test("a folded child is redacted the same as a fetched one", async () => {
    const { batched, lateral } = await bothStrategies({
      include: { ledgers: true },
    });

    for (const row of batched[0].ledgers) expect(row.secret).toBeNull();
    for (const row of lateral[0].ledgers) expect(row.secret).toBeNull();
    expect(lateral[0].ledgers).toEqual(batched[0].ledgers);
  });

  /** And through a `select`, which takes a different path into the same fold. */
  test("a selected relation is redacted under both", async () => {
    const { batched, lateral } = await bothStrategies({
      select: { title: true, ledgers: { select: { label: true, secret: true } } },
    });

    for (const row of batched[0].ledgers) expect(row.secret).toBeNull();
    for (const row of lateral[0].ledgers) expect(row.secret).toBeNull();
  });
});
