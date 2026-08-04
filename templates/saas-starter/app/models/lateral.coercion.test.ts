import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  clearPlanCache,
  register,
  type ModelSchema,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * Every scalar type, through a **relation**, under both strategies.
 *
 * This closes the gap I named in #54 as the thing to check hardest: the decoder is
 * the only place where lateral and batched can disagree about a *value* rather
 * than about SQL, and the template's own schema reaches a relation carrying a
 * `DateTime` but not one carrying `Bytes`, `BigInt`, `Json`, `Boolean` or `Float`.
 * So the differential matrix — thirty cases — cannot see those conversions at all.
 *
 * The mechanism being tested: `json_build_object` flattens types on the way out.
 * A `bytea` becomes `\x`-prefixed hex, a `bigint` becomes a string or a number
 * depending on magnitude, a `timestamp` becomes ISO text, `boolean` and `double
 * precision` survive. The batched path never sees any of that, because its
 * children arrive through the driver's own type mapping. So for every type the
 * question is the same and has to be asked once per type: **does the folded child
 * equal the fetched child?**
 *
 * Postgres only — the strategy declines every other dialect — and a fixture rather
 * than the template's schema, the same trade `writes.coercion.test.ts` records.
 *
 * ```prisma
 * model Vault  { id Int @id @default(autoincrement())  name String  items Item[] }
 * model Item {
 *   id      Int      @id @default(autoincrement())
 *   vaultId Int
 *   vault   Vault    @relation(fields: [vaultId], references: [id])
 *   text    String
 *   flag    Boolean
 *   count   BigInt
 *   ratio   Float
 *   payload Json
 *   blob    Bytes
 *   when    DateTime
 *   maybe   String?
 * }
 * ```
 */

const DDL = [
  `DROP TABLE IF EXISTS "Item"`,
  `DROP TABLE IF EXISTS "Vault"`,
  `CREATE TABLE "Vault" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "name" TEXT NOT NULL
   )`,
  `CREATE TABLE "Item" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "vaultId" INTEGER NOT NULL REFERENCES "Vault"("id"),
     "text" TEXT NOT NULL,
     "flag" BOOLEAN NOT NULL,
     "count" BIGINT NOT NULL,
     "ratio" DOUBLE PRECISION NOT NULL,
     "payload" JSONB NOT NULL,
     "blob" BYTEA NOT NULL,
     "when" TIMESTAMP(3) NOT NULL,
     "maybe" TEXT
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

const vault: ModelSchema = {
  name: "Vault",
  table: "Vault",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    name: field("name", "String"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    items: {
      name: "items",
      model: "Item",
      kind: "many",
      relationName: "ItemToVault",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const item: ModelSchema = {
  name: "Item",
  table: "Item",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    vaultId: field("vaultId", "Int"),
    text: field("text", "String"),
    flag: field("flag", "Boolean"),
    count: field("count", "BigInt"),
    ratio: field("ratio", "Float"),
    payload: field("payload", "Json"),
    blob: field("blob", "Bytes"),
    when: field("when", "DateTime"),
    maybe: field("maybe", "String", { nullable: true }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    vault: {
      name: "vault",
      model: "Vault",
      kind: "one",
      relationName: "ItemToVault",
      from: ["vaultId"],
      to: ["id"],
      nullable: false,
    },
  },
};

class VaultModel extends Model {
  static $schema = vault;
}
class ItemModel extends Model {
  static $schema = item;
}

const WHEN = new Date("2021-03-04T05:06:07.008Z");

const VALUES = {
  text: "hello",
  flag: true,
  count: 9_007_199_254_740_993n, // past 2^53, so a number would lose it
  ratio: 1.5,
  payload: { nested: { list: [1, 2, 3] }, flag: true },
  blob: new Uint8Array([0, 1, 2, 253, 254, 255]),
  when: WHEN,
  maybe: null,
};

const RUN = POSTGRES_URL ? describe : describe.skip;

RUN("every scalar through a relation, lateral vs batched — postgres", () => {
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

    register("Vault", VaultModel);
    register("Item", ItemModel);
  }, 120_000);

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS "Item"`).catch(() => {});
    await raw?.unsafe(`DROP TABLE IF EXISTS "Vault"`).catch(() => {});
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(`TRUNCATE "Item", "Vault" RESTART IDENTITY CASCADE`);

    await Model.asSystem(async () => {
      const created: any = await VaultModel.$exec("create", {
        data: { name: "main" },
      });
      await ItemModel.$exec("create", {
        data: { ...VALUES, vaultId: created.id },
      });
    });
  });

  async function bothStrategies(args: any) {
    const batched = (await VaultModel.$exec("findMany", args, {
      strategy: "batched",
    } as never)) as any[];
    const lateral = (await VaultModel.$exec("findMany", args, {
      strategy: "lateral",
    } as never)) as any[];
    return { batched, lateral };
  }

  /**
   * The headline: every type at once, compared value by value. A `toEqual` over
   * the whole row would pass on two `Uint8Array`s of different contents in some
   * matchers, so the types that need it are compared explicitly below.
   */
  test("a folded child equals a fetched child, for every scalar type", async () => {
    const { batched, lateral } = await bothStrategies({
      include: { items: true },
    });

    expect(lateral[0].items).toHaveLength(1);
    expect(batched[0].items).toHaveLength(1);

    const folded = lateral[0].items[0];
    const fetched = batched[0].items[0];

    expect(folded.text).toBe(fetched.text);
    expect(folded.flag).toBe(fetched.flag);
    expect(folded.ratio).toBe(fetched.ratio);
    expect(folded.maybe).toBe(fetched.maybe);
    expect(folded.payload).toEqual(fetched.payload);
  });

  /**
   * `bigint` past 2^53. JSON has no bigint, so `json_build_object` renders it as a
   * number or a string depending on the driver — and a number would silently lose
   * the low bits. The batched path gets a real `bigint` from the driver.
   */
  test("BigInt survives the fold past 2^53", async () => {
    const { batched, lateral } = await bothStrategies({
      include: { items: true },
    });

    expect(typeof lateral[0].items[0].count).toBe("bigint");
    expect(lateral[0].items[0].count).toBe(VALUES.count);
    expect(lateral[0].items[0].count).toBe(batched[0].items[0].count);
  });

  /** `bytea` renders into JSON as `\x` followed by hex, not as bytes. */
  test("Bytes survives the fold, byte for byte", async () => {
    const { batched, lateral } = await bothStrategies({
      include: { items: true },
    });

    const folded = lateral[0].items[0].blob;
    const fetched = batched[0].items[0].blob;

    expect([...folded]).toEqual([...VALUES.blob]);
    expect([...folded]).toEqual([...fetched]);

    // The *container*, not just the contents. `[...x]` spreads a `Buffer` and a
    // `Uint8Array` to the same plain array, so a content-only comparison passes
    // for two different types — which is how the first version of this test
    // missed a real divergence it was written to catch.
    //
    // `Uint8Array` on both sides, because that is what Prisma 6 returns on
    // every dialect and what this ORM returns on SQLite. The first fix here
    // converged both Postgres paths on `Buffer` instead, which made the two
    // strategies agree with each other and with nothing else.
    expect(Buffer.isBuffer(folded)).toBe(false);
    expect(Buffer.isBuffer(fetched)).toBe(false);
    expect(folded.constructor.name).toBe("Uint8Array");
    expect(fetched.constructor.name).toBe("Uint8Array");

    // The call that made the difference observable rather than academic.
    // `Uint8Array.prototype.toString` ignores its argument, so this is the
    // comma form on both paths — the same answer a caller gets from Prisma.
    expect(folded.toString("hex")).toBe(fetched.toString("hex"));
    expect(folded.toString("hex")).toBe("0,1,2,253,254,255");
  });

  /** ISO text out of the aggregate, where the driver would have given a `Date`. */
  test("DateTime comes back as a Date, at the same instant", async () => {
    const { batched, lateral } = await bothStrategies({
      include: { items: true },
    });

    expect(lateral[0].items[0].when).toBeInstanceOf(Date);
    expect(lateral[0].items[0].when.getTime()).toBe(WHEN.getTime());
    expect(lateral[0].items[0].when.getTime()).toBe(
      batched[0].items[0].when.getTime(),
    );
  });

  /**
   * `jsonb` nested inside `json_build_object` is JSON inside JSON — the risk is a
   * double encode coming back as a *string* where the batched path gives an
   * object.
   */
  test("Json stays an object rather than becoming a string", async () => {
    const { lateral } = await bothStrategies({ include: { items: true } });

    expect(typeof lateral[0].items[0].payload).toBe("object");
    expect(lateral[0].items[0].payload).toEqual(VALUES.payload);
  });

  test("a narrowed select folds only what it names, decoded correctly", async () => {
    const { batched, lateral } = await bothStrategies({
      include: { items: { select: { count: true, blob: true } } },
    });

    expect(Object.keys(lateral[0].items[0]).sort()).toEqual(["blob", "count"]);
    expect(lateral[0].items[0].count).toBe(batched[0].items[0].count);
    expect([...lateral[0].items[0].blob]).toEqual([
      ...batched[0].items[0].blob,
    ]);
    expect(lateral[0].items[0].blob.constructor.name).toBe(
      batched[0].items[0].blob.constructor.name,
    );
  });

  /** The to-one direction, which takes the non-aggregate path in the strategy. */
  test("a to-one fold decodes the same types", async () => {
    const batched = (await ItemModel.$exec(
      "findMany",
      { include: { vault: true } },
      { strategy: "batched" } as never,
    )) as any[];
    const lateral = (await ItemModel.$exec(
      "findMany",
      { include: { vault: true } },
      { strategy: "lateral" } as never,
    )) as any[];

    expect(lateral[0].vault).toEqual(batched[0].vault);
    expect(lateral[0].vault.name).toBe("main");
  });
});
