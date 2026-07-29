import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, register, type ModelSchema } from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * Round-tripping every scalar type: write a value, read it back, and get the
 * same JavaScript value out.
 *
 * `encode` is the mirror of iteration 1's `decode`, and the two are only
 * correct *together* — a bug in one that exactly cancels a bug in the other is
 * invisible to any test that uses the same code for both halves. So the write
 * goes through the ORM and the read is checked against the raw driver as well.
 *
 * The template's own schema cannot exercise this: every column in it is an Int,
 * a String or a DateTime. There is no Boolean, no Json, no BigInt and no Bytes.
 * So this fixture is a database rather than a Prisma client, the same trade
 * `relations.many-to-many.test.ts` records — the DDL below is what
 * `prisma migrate` emits for the model in the comment.
 *
 * `Decimal` is absent on purpose: iteration 1 refuses it at *generation* time,
 * because SQLite stores it as a REAL and the driver hands back a float
 * pretending to be an arbitrary-precision decimal. There is a test for that
 * refusal in `bin/orm/emit.test.ts`; a round-trip here would be asserting
 * behaviour that cannot be reached.
 *
 * ```prisma
 * model Everything {
 *   id       Int      @id @default(autoincrement())
 *   text     String
 *   flag     Boolean  @default(false)
 *   count    BigInt
 *   ratio    Float
 *   payload  Json
 *   blob     Bytes
 *   when     DateTime
 *   optional String?
 *   uid      String   @default(uuid())
 *   made     DateTime @default(now())
 *   touched  DateTime @updatedAt
 * }
 * ```
 */

const SQLITE_DDL = `CREATE TABLE "Everything" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL,
    "flag" BOOLEAN NOT NULL DEFAULT false,
    "count" BIGINT NOT NULL,
    "ratio" REAL NOT NULL,
    "payload" JSONB NOT NULL,
    "blob" BLOB NOT NULL,
    "when" DATETIME NOT NULL,
    "optional" TEXT,
    "uid" TEXT NOT NULL,
    "made" DATETIME NOT NULL,
    "touched" DATETIME NOT NULL
)`;

const POSTGRES_DDL = `CREATE TABLE "Everything" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "flag" BOOLEAN NOT NULL DEFAULT false,
    "count" BIGINT NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "payload" JSONB NOT NULL,
    "blob" BYTEA NOT NULL,
    "when" TIMESTAMP(3) NOT NULL,
    "optional" TEXT,
    "uid" TEXT NOT NULL,
    "made" TIMESTAMP(3) NOT NULL,
    "touched" TIMESTAMP(3) NOT NULL
)`;

function field(
  name: string,
  type: any,
  extra: Record<string, unknown> = {},
): any {
  return {
    name,
    column: name,
    type,
    nullable: false,
    isId: false,
    isUpdatedAt: false,
    ...extra,
  };
}

const everything: ModelSchema = {
  name: "Everything",
  table: "Everything",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    text: field("text", "String"),
    flag: field("flag", "Boolean", { default: { kind: "value", value: false } }),
    count: field("count", "BigInt"),
    ratio: field("ratio", "Float"),
    payload: field("payload", "Json"),
    blob: field("blob", "Bytes"),
    when: field("when", "DateTime"),
    optional: field("optional", "String", { nullable: true }),
    uid: field("uid", "String", { default: { kind: "uuid" } }),
    made: field("made", "DateTime", { default: { kind: "now" } }),
    touched: field("touched", "DateTime", { isUpdatedAt: true }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

class EverythingModel extends Model {
  static $schema = everything;
}

const WHEN = new Date("2021-03-04T05:06:07.008Z");

/**
 * A `Bytes` value, asserted by **container** as well as contents.
 *
 * Contents alone cannot see the divergence that matters here. `Buffer` is a
 * `Uint8Array` subclass, so `[...a]` and `toEqual` treat the two as identical
 * — and until this helper existed, every assertion in this file did exactly
 * that. What the two do not share is `toString`: `Buffer.prototype.toString`
 * takes an encoding, `Uint8Array.prototype.toString` ignores its argument. So
 * `row.blob.toString("hex")` returned `"0102ff"` on Postgres and `"1,2,255"`
 * on SQLite, from the same schema, with nothing failing.
 *
 * `Uint8Array` is the contract because it is what Prisma 6 returns, on every
 * dialect — verified against a generated client rather than assumed. This
 * helper runs in both dialects' suites, which is what makes it a cross-dialect
 * pin rather than two independent checks.
 */
function expectBytes(actual: unknown, expected: ArrayLike<number>) {
  expect(ArrayBuffer.isView(actual)).toBe(true);
  expect(Buffer.isBuffer(actual)).toBe(false);
  expect((actual as object).constructor.name).toBe("Uint8Array");
  expect([...(actual as Uint8Array)]).toEqual(Array.from(expected));
}

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-coercion-"));
        target = `sqlite://${join(workspace, "coercion.db")}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      await raw.unsafe(`DROP TABLE IF EXISTS "Everything"`);
      await raw.unsafe(url ? POSTGRES_DDL : SQLITE_DDL);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);

      register("Everything", EverythingModel);
    }, 120_000);

    afterAll(async () => {
      await raw?.unsafe(`DROP TABLE IF EXISTS "Everything"`).catch(() => {});
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      await raw.unsafe(`DELETE FROM "Everything"`);
    });

    const values = {
      text: "hello",
      flag: true,
      count: 9007199254740991n,
      ratio: 1.5,
      payload: { nested: { list: [1, 2, 3] }, flag: true },
      blob: new Uint8Array([0, 1, 2, 253, 254, 255]),
      when: WHEN,
      optional: null,
    };

    test("every scalar type round-trips through create", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: values,
      });

      // Written and returned in one statement, straight off RETURNING.
      expect(created.text).toBe("hello");
      expect(created.flag).toBe(true);
      expect(created.count).toBe(9007199254740991n);
      expect(created.ratio).toBe(1.5);
      expect(created.payload).toEqual(values.payload);
      expectBytes(created.blob, values.blob);
      expect(created.when).toBeInstanceOf(Date);
      expect(created.when.getTime()).toBe(WHEN.getTime());
      expect(created.optional).toBeNull();

      // And read back on a second statement, which is the half that proves
      // `encode` and `decode` agree with the *database* rather than only with
      // each other.
      const read: any = await EverythingModel.$exec("findUniqueOrThrow", {
        where: { id: created.id },
      });
      expect(read.flag).toBe(true);
      expect(read.count).toBe(9007199254740991n);
      expect(read.ratio).toBe(1.5);
      expect(read.payload).toEqual(values.payload);
      expectBytes(read.blob, values.blob);
      expect(read.when.getTime()).toBe(WHEN.getTime());
      expect(read.optional).toBeNull();
    });

    // A known driver limitation, pinned rather than avoided. Bun's SQLite
    // driver truncates an integer parameter above 2^53 on the way in — it binds
    // through a double — so a BigInt past that loses its low bits. It is not
    // something `encode` can correct at the parameter level, and a raw
    // `db.sql` query through the same driver behaves identically. The note is
    // in orm/dialect/sqlite.ts; this is the executable half of it.
    //
    // Postgres binds bigints natively and is exact, which is why the assertion
    // splits by dialect rather than being skipped.
    test("BigInt past 2^53 is exact on postgres, truncated on sqlite", async () => {
      const beyond = 9007199254740993n; // 2^53 + 1
      const created: any = await EverythingModel.$exec("create", {
        data: { ...values, count: beyond },
      });

      if (url) {
        expect(created.count).toBe(beyond);
      } else {
        expect(created.count).toBe(9007199254740992n);
      }
    });

    test("false and zero survive, rather than falling back to a default", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: { ...values, flag: false, ratio: 0, count: 0n, text: "" },
      });
      expect(created.flag).toBe(false);
      expect(created.ratio).toBe(0);
      expect(created.count).toBe(0n);
      expect(created.text).toBe("");
    });

    test("client-side defaults are generated on create", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: values,
      });

      expect(created.uid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created.made).toBeInstanceOf(Date);
      expect(created.touched).toBeInstanceOf(Date);
      // `now()` and `@updatedAt` are one instant for one logical operation.
      expect(created.made.getTime()).toBe(created.touched.getTime());
      // The `@default(false)` static value, applied client-side.
      expect(created.flag).toBe(true);
    });

    test("@updatedAt advances on update while now() stays put", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: values,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const updated: any = await EverythingModel.$exec("update", {
        where: { id: created.id },
        data: { text: "changed" },
      });

      expect(updated.made.getTime()).toBe(created.made.getTime());
      expect(updated.touched.getTime()).toBeGreaterThan(
        created.touched.getTime(),
      );
    });

    test("values round-trip through update too", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: values,
      });

      const updated: any = await EverythingModel.$exec("update", {
        where: { id: created.id },
        data: {
          flag: false,
          count: -42n,
          payload: [1, "two", null],
          blob: new Uint8Array([9, 8, 7]),
          when: new Date("1999-12-31T23:59:59.999Z"),
          optional: "now set",
        },
      });

      expect(updated.flag).toBe(false);
      expect(updated.count).toBe(-42n);
      expect(updated.payload).toEqual([1, "two", null]);
      expectBytes(updated.blob, [9, 8, 7]);
      expect(updated.when.toISOString()).toBe("1999-12-31T23:59:59.999Z");
      expect(updated.optional).toBe("now set");
    });

    /**
     * The `Json` shapes that are not containers, which is where both dialects
     * used to be wrong in the same way and for the same reason: a JS string is
     * ambiguous between "already JSON text" and "a JSON string value", and both
     * encoders guessed by `typeof`.
     *
     * `"42"` was stored as the bare text `42` and read back as the *number* 42;
     * `'{"a":1}'` came back as an object. Round-tripping is the only way to see
     * it — the write looks fine and the read looks fine, and only together do
     * they disagree with what was handed in.
     */
    test.each([
      ["a JSON string", "42"],
      ["a string whose contents are JSON", '{"a":1}'],
      ["a string that is not JSON", "plain text"],
      ["a JSON array", [1, "two", null]],
      ["an empty object", {}],
      ["an empty array", []],
    ])("%s round-trips through Json unchanged", async (_label, payload) => {
      const created: any = await EverythingModel.$exec("create", {
        data: { ...values, payload },
      });
      expect(created.payload).toEqual(payload);

      // Read back through a second statement, so this is the stored value
      // rather than whatever the write happened to return.
      const read: any = await EverythingModel.$exec("findUniqueOrThrow", {
        where: { id: created.id },
      });
      expect(read.payload).toEqual(payload);
      expect(typeof read.payload).toBe(typeof payload);
    });

    /**
     * Every `Json` shape round-trips, including the two that used to be refused.
     *
     * A bare JSON number or boolean was the one shape Bun binds as its own type
     * — it has no way to know the parameter is destined for a `jsonb` column —
     * so Postgres answered `column "payload" is of type jsonb but expression is
     * of type integer`, and the ORM let that through as a loud failure rather
     * than storing something wrong.
     *
     * The compiler now asks the dialect for a cast and serialises the value to
     * match: `$1::text::jsonb`. That is the only form of the four measured in
     * #209 that carries all six shapes — the raw bind refuses scalars, a bare
     * `::jsonb` stores the jsonb *string* `"42"`, and `to_jsonb($1)` cannot type
     * an object, an array, a string or null.
     *
     * `jsonb_typeof` is asserted as well as the value, because the mis-store
     * this replaces was a *right-looking value under the wrong type*: `"42"`
     * reads back as `42` through this ORM and as a string through anything else.
     * Equality alone could not tell the two apart, which is how it survived.
     */
    test.each([
      ["a JSON number", 7, "number"],
      ["a JSON boolean", true, "boolean"],
      ["a JSON string", "42", "string"],
      ["an object", { a: 1 }, "object"],
      ["an array", [1, 2, 3], "array"],
    ])("%s round-trips", async (_label, payload, kind) => {
      const created: any = await EverythingModel.$exec("create", {
        data: { ...values, payload },
      });
      expect(created.payload).toEqual(payload);

      const read: any = await EverythingModel.$exec("findFirst", {
        where: { id: created.id },
      });
      expect(read.payload).toEqual(payload);

      if (!url) return;

      // The half the ORM cannot see: what the column actually holds.
      const rows: any = await raw.unsafe(
        `SELECT jsonb_typeof("payload") AS kind FROM "Everything" WHERE "id" = $1`,
        [created.id],
      );
      expect([...rows][0].kind).toBe(kind);
    });

    /**
     * What a fix would have to be built on — postgres.
     *
     * The boundary above is recorded as temporary, and the note saying how to
     * lift it was wrong: "serialise and emit `::jsonb`" reproduces the silent
     * mis-store it warns about, because Bun serialises a JS string bound to a
     * `jsonb` parameter and pre-serialising encodes it twice.
     *
     * That is a claim about the *driver*, not about this ORM, so nothing in the
     * compiler would notice it changing. Pinned at the level it is true: if a
     * later Bun binds these differently, this fails and the note above is stale
     * rather than quietly wrong again.
     */
    test("the one binding a jsonb fix can use — postgres", async () => {
      if (!url) return;

      await raw.unsafe(`DROP TABLE IF EXISTS "JsonProbe"`);
      await raw.unsafe(`CREATE TABLE "JsonProbe" ("payload" jsonb)`);

      const insert = async (text: string, value: unknown) => {
        await raw.unsafe(`DELETE FROM "JsonProbe"`);
        await raw.unsafe(`INSERT INTO "JsonProbe" ("payload") VALUES (${text})`, [value]);
        const rows: any = await raw.unsafe(
          `SELECT "payload", jsonb_typeof("payload") AS kind FROM "JsonProbe"`,
        );
        return [...rows][0];
      };

      const shapes: [string, unknown, string][] = [
        ["an object", { a: 1 }, "object"],
        ["an array", [1, 2], "array"],
        ["a string", "42", "string"],
        ["a number", 42, "number"],
        ["a boolean", true, "boolean"],
        ["null", null, "null"],
      ];

      // The only form that carries every shape: serialise, then cast through
      // text. Value *and* `jsonb_typeof`, because the mis-store this replaces
      // was a right-looking value under the wrong type.
      for (const [, value, kind] of shapes) {
        const row = await insert("$1::text::jsonb", JSON.stringify(value));
        expect(row.kind).toBe(kind);
        expect(row.payload).toEqual(value);
      }

      // The remedy that was written down, and reproduces the old mis-store.
      expect((await insert("$1::jsonb", JSON.stringify(42))).kind).toBe("string");

      // `to_jsonb($1)` looks like a second answer and is not: it carries the two
      // shapes Bun binds as a concrete type, and fails on the rest because an
      // unannotated parameter leaves the polymorphic argument untyped. Pinned so
      // nobody adopts it from the two rows that work.
      expect((await insert("to_jsonb($1)", 42)).kind).toBe("number");
      expect((await insert("to_jsonb($1)", true)).kind).toBe("boolean");
      for (const value of [{ a: 1 }, [1, 2], "42", null]) {
        await expect(insert("to_jsonb($1)", value)).rejects.toThrow(
          /polymorphic type/,
        );
      }

      await raw.unsafe(`DROP TABLE IF EXISTS "JsonProbe"`);
    });

    test("createMany round-trips every row", async () => {
      const result: any = await EverythingModel.$exec("createMany", {
        data: [
          { ...values, text: "one", count: 1n },
          { ...values, text: "two", count: 2n, flag: false },
        ],
      });
      expect(result).toEqual({ count: 2 });

      const rows: any = await EverythingModel.$exec("findMany", {
        orderBy: { id: "asc" },
      });
      expect(rows.map((row: any) => row.text)).toEqual(["one", "two"]);
      expect(rows.map((row: any) => row.count)).toEqual([1n, 2n]);
      expect(rows.map((row: any) => row.flag)).toEqual([true, false]);
      // Each row gets its own uuid, not one shared across the statement.
      expect(rows[0].uid).not.toBe(rows[1].uid);
    });

    test("a value written by gemi reads the same through the raw driver", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: values,
      });

      const [row]: any = await raw.unsafe(
        `select "flag", "when", "payload" from "Everything" where "id" = ${
          url ? "$1" : "?"
        }`,
        [created.id],
      );

      // The storage form, not the decoded one: Prisma stores a SQLite DateTime
      // as integer milliseconds and a Boolean as 0/1, and matching that is what
      // makes a gemi-written row readable by the Prisma client.
      if (url) {
        expect(row.flag).toBe(true);
        expect(row.when).toBeInstanceOf(Date);
      } else {
        expect(row.when).toBe(WHEN.getTime());
        expect(Number(row.flag)).toBe(1);
        expect(typeof row.payload).toBe("string");
        expect(JSON.parse(row.payload)).toEqual(values.payload);
      }
    });

    test("delete returns the row it removed, fully decoded", async () => {
      const created: any = await EverythingModel.$exec("create", {
        data: values,
      });

      const deleted: any = await EverythingModel.$exec("delete", {
        where: { id: created.id },
      });
      expect(deleted.count).toBe(9007199254740991n);
      expectBytes(deleted.blob, values.blob);

      expect(await EverythingModel.$exec("count", {})).toBe(0);
    });
  });
}

suite("write coercion — sqlite");

if (POSTGRES_URL) {
  suite("write coercion — postgres", POSTGRES_URL);
} else {
  describe("write coercion — postgres", () => {
    test("SKIPPED — set TEST_POSTGRES_URL to run the Postgres dialect", () => {
      console.warn(
        "\n  ⚠  Postgres write coercion tests did NOT run.\n" +
          "     Set TEST_POSTGRES_URL to a scratch database to cover the " +
          "postgres dialect.\n",
      );
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}
