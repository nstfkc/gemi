import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { DB } from "gemi/facades";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, empty, join, sql, unsafeSql } from "gemi/orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import { User } from "./User";

/**
 * Composed raw SQL against a real database.
 *
 * `sql.test.ts` in the framework covers what a fragment *emits*, with no
 * database anywhere near it. What it cannot cover is the half that only a
 * driver can answer, and that half is where the surprises live:
 *
 * - **The rowcount.** Bun reports it on `count` and leaves `affectedRows` null,
 *   on both dialects. That is measured behaviour rather than documented
 *   behaviour, so it belongs in a test that would notice it changing.
 * - **The ambient transaction.** A raw statement that quietly runs on a pooled
 *   connection while `Model.transaction` holds a reserved one commits while its
 *   neighbours roll back — the worst outcome available here, and invisible in
 *   any test that does not deliberately roll back.
 *
 * Both dialects, because the two agree about neither for free.
 */

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(joinPath(tmpdir(), "gemi-orm-raw-"));
        const path = joinPath(workspace, "raw.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    // Children before parents, and every table rather than the ones this suite
    // writes to: on Postgres the whole run shares one database, so a row another
    // suite left behind fails a delete here that never touched it.
    const TABLES = [
      "SocialAccount",
      "Session",
      "PasswordResetToken",
      "MagicLinkToken",
      "Account",
      "User",
      "OrganizationInvitation",
      "Organization",
    ];

    beforeEach(async () => {
      clearPlanCache();

      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(", ")} ` +
            `RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) {
          await raw.unsafe(`DELETE FROM "${table}"`);
        }
      }

      await Model.asSystem(async () => {
        await User.create({ data: { email: "ada@x.test", globalRole: 0 } });
        await User.create({ data: { email: "grace@x.test", globalRole: 1 } });
        await User.create({ data: { email: "hopper@x.test", globalRole: 1 } });
      });
    });

    async function emails(): Promise<string[]> {
      const rows: any = await raw.unsafe(
        `SELECT "email" FROM "User" ORDER BY "id"`,
      );
      return [...rows].map((row: any) => row.email);
    }

    // --- reading ----------------------------------------------------------

    test("query returns rows, with the value bound", async () => {
      const rows = await DB.query<{ email: string }>(
        sql`select "email" from "User" where "globalRole" = ${1} order by "id"`,
      );

      expect(rows.map((row) => row.email)).toEqual([
        "grace@x.test",
        "hopper@x.test",
      ]);
    });

    /**
     * A parsed request body reaching an interpolation slot, which is the
     * intended call site with the intended safe value:
     *
     *   const body = await request.json()
     *   DB.query(sql`select "email" from "User" where "email" = ${body.email}`)
     *
     * When "is this a fragment" was answered by *shape*, `{"text": …,
     * "binders": []}` in that body was spliced into the statement as text.
     * These run the forged bodies through the public facade against a real
     * database, because the assertion that matters is not what the compiler
     * emits — it is what comes back.
     */
    test("a forged fragment in a request body cannot splice into the statement", async () => {
      const search = (email: unknown) =>
        DB.query<{ email: string }>(
          sql`select "email" from "User" where "email" = ${email}`,
        );

      expect(await search("ada@x.test")).toHaveLength(1);

      // `'' or 1=1` would have returned every row.
      expect(await search({ text: `'' or 1=1`, binders: [] })).toHaveLength(0);

      // ...and this one returned the password column out of a statement that
      // selects only `email`.
      const leak = await search({
        text: `'' union select "password" from "User"`,
        binders: [],
      });
      expect(leak).toHaveLength(0);

      // A structural clone of a real fragment is the same attack without the
      // hand-written text: shape cannot tell it apart, membership can.
      const real = sql`x`;
      expect(
        await search({ text: real.text, binders: [...real.binders] }),
      ).toHaveLength(0);

      // The table is intact and the honest query still works, so the guard is
      // not simply refusing everything.
      expect(await emails()).toHaveLength(3);
    });

    test("a forged fragment inside join binds too", async () => {
      const rows = await DB.query(
        sql`select "email" from "User" where "email" in (${join([
          { text: `'' or 1=1`, binders: [] },
        ])})`,
      );

      expect(rows).toHaveLength(0);
    });

    test("a value that looks like SQL is data, not SQL", async () => {
      const injected = `x' or 1=1; drop table "User"; --`;
      const rows = await DB.query(
        sql`select "email" from "User" where "email" = ${injected}`,
      );

      expect(rows).toHaveLength(0);
      // The table is still there, which is the assertion that would have
      // caught an implementation that concatenated.
      expect(await emails()).toHaveLength(3);
    });

    /**
     * The shape the whole mechanism is for: predicates built conditionally, as
     * values, and composed into one statement.
     */
    test("a conditional filter list composes", async () => {
      const search = async (q?: string, role?: number) => {
        const filters = [];
        if (q) filters.push(sql`"email" like ${`%${q}%`}`);
        if (role !== undefined) filters.push(sql`"globalRole" = ${role}`);

        const where = filters.length
          ? sql`where ${join(filters, " and ")}`
          : empty;

        const rows = await DB.query<{ email: string }>(
          sql`select "email" from "User" ${where} order by "id"`,
        );
        return rows.map((row) => row.email);
      };

      expect(await search()).toHaveLength(3);
      expect(await search("ada")).toEqual(["ada@x.test"]);
      expect(await search(undefined, 1)).toEqual([
        "grace@x.test",
        "hopper@x.test",
      ]);
      expect(await search("hopper", 1)).toEqual(["hopper@x.test"]);
      expect(await search("hopper", 0)).toEqual([]);
    });

    test("join over a list of values becomes an in-list", async () => {
      const rows = await DB.query<{ email: string }>(
        sql`select "email" from "User"
            where "email" in (${join(["ada@x.test", "hopper@x.test"])})
            order by "id"`,
      );

      expect(rows.map((row) => row.email)).toEqual([
        "ada@x.test",
        "hopper@x.test",
      ]);
    });

    test("unsafeSql puts text in the statement, and it runs", async () => {
      const direction = unsafeSql("desc");
      const rows = await DB.query<{ email: string }>(
        sql`select "email" from "User" where "globalRole" >= ${0}
            order by "id" ${direction}`,
      );

      expect(rows[0].email).toBe("hopper@x.test");
    });

    // --- writing ----------------------------------------------------------

    test("execute returns the number of rows a write touched", async () => {
      expect(
        await DB.execute(
          sql`update "User" set "locale" = ${"tr-TR"} where "globalRole" = ${1}`,
        ),
      ).toBe(2);

      expect(
        await DB.execute(
          sql`update "User" set "locale" = ${"tr-TR"} where "globalRole" = ${9}`,
        ),
      ).toBe(0);

      expect(
        await DB.execute(sql`delete from "User" where "email" = ${"ada@x.test"}`),
      ).toBe(1);

      expect(await emails()).toEqual(["grace@x.test", "hopper@x.test"]);
    });

    /**
     * The reason the rowcount is not a diagnostic. `UPDATE … WHERE status =
     * 'reserved'` returning 1 means this caller won the race and 0 means it
     * lost; an API that discarded the number could not express it at all.
     */
    test("the rowcount is usable as a compare-and-swap", async () => {
      const claim = () =>
        DB.execute(
          sql`update "User" set "verificationToken" = ${"claimed"}
              where "email" = ${"ada@x.test"} and "verificationToken" is null`,
        );

      expect(await claim()).toBe(1);
      // The second caller loses, because the row no longer matches.
      expect(await claim()).toBe(0);
    });

    test("execute on an insert counts the row it wrote", async () => {
      expect(
        await DB.execute(
          sql`insert into "User" ("publicId", "email", "globalRole",
                                  "createdAt", "updatedAt")
              values (${"raw-1"}, ${"raw@x.test"}, ${2},
                      ${new Date()}, ${new Date()})`,
        ),
      ).toBe(1);

      expect(await emails()).toHaveLength(4);
    });

    // --- a jsonb parameter -------------------------------------------------

    /**
     * **A `::jsonb` cast in a raw statement, which is where a Prisma port goes
     * wrong silently.** Postgres only: SQLite has no `jsonb` type and no `::`
     * operator, so these statements are not expressible there at all.
     *
     * The divergence is the parameter's type rather than the cast's. Prisma's
     * `$executeRaw` sends a JS string as `text` and lets Postgres parse it; Bun
     * asks the server what the statement wants, is told `jsonb`, and
     * JSON-encodes the string — so the document is stored as a jsonb *string*.
     * `renderFragment` now retypes such a parameter through `text`.
     *
     * `jsonb_typeof` is asserted rather than the value alone, for the reason
     * `writes.coercion.test.ts` gives about the same mis-store: the wrong answer
     * *reads back correctly through this ORM* and wrongly through everything
     * else, so equality cannot tell the two apart.
     */
    const metadataOf = async (email: string) => {
      const rows: any = await raw.unsafe(
        `SELECT jsonb_typeof("metadata") AS kind, "metadata" AS value
           FROM "User" WHERE "email" = $1`,
        [email],
      );
      return [...rows][0];
    };

    test("a document at a ::jsonb cast is stored as the document — postgres", async () => {
      if (!url) return;

      const document = { version: 1, tags: ["a", "b"] };

      expect(
        await DB.execute(
          sql`update "User" set "metadata" = ${JSON.stringify(document)}::jsonb
              where "email" = ${"ada@x.test"}`,
        ),
      ).toBe(1);

      const stored = await metadataOf("ada@x.test");
      expect(stored.kind).toBe("object");
      expect(stored.value).toEqual(document);
    });

    /**
     * The sharp end, and the reason this is worth a fix rather than a caveat.
     * `||` between an object and a jsonb *string* is array concatenation, not a
     * merge: the statement below appended the serialised text as a new element
     * and the column stopped being an object at all. Downstream code that
     * expects an object gets an array, or drops the row when a guard fails.
     */
    test("|| merges into the document rather than appending to it — postgres", async () => {
      if (!url) return;

      await DB.execute(
        sql`update "User" set "metadata" = ${JSON.stringify({ attribution: "x" })}::jsonb
            where "email" = ${"ada@x.test"}`,
      );

      await DB.execute(
        sql`update "User" set "metadata" = "metadata" || ${JSON.stringify({ version: 1 })}::jsonb
            where "email" = ${"ada@x.test"}`,
      );

      const stored = await metadataOf("ada@x.test");
      expect(stored.kind).toBe("object");
      expect(stored.value).toEqual({ attribution: "x", version: 1 });
    });

    /**
     * The claim about the *driver* that the fix rests on, pinned at the level it
     * is true. Nothing in the ORM would notice Bun changing this, and if a later
     * version binds it differently the retyping is solving a problem that no
     * longer exists — which this failing is the only way to find out.
     */
    test("the same statement unretyped stores a jsonb string — postgres", async () => {
      if (!url) return;

      const document = JSON.stringify({ version: 1 });
      await raw.unsafe(
        `UPDATE "User" SET "metadata" = $1::jsonb WHERE "email" = $2`,
        [document, "ada@x.test"],
      );

      const stored = await metadataOf("ada@x.test");
      expect(stored.kind).toBe("string");
      expect(stored.value).toBe(document);

      // ...and the `||` above, on the same binding: an array, not a merge.
      await raw.unsafe(
        `UPDATE "User" SET "metadata" = '{"attribution":"x"}'::jsonb || $1::jsonb
           WHERE "email" = $2`,
        [document, "ada@x.test"],
      );
      expect((await metadataOf("ada@x.test")).kind).toBe("array");
    });

    /**
     * Every shape, through the cast, and the function spelling of it — which is
     * the other form a port can be carrying (`CAST($1 AS jsonb)`), and which
     * mis-stores identically without the retyping.
     */
    test.each([
      ["an object", { a: 1 }, "object"],
      ["an array", [1, 2], "array"],
      ["a document as text", `{"a":1}`, "object"],
      ["a number", 42, "number"],
      ["a boolean", true, "boolean"],
    ])("%s survives both cast spellings — postgres", async (_label, value, kind) => {
      if (!url) return;

      for (const fragment of [
        sql`update "User" set "metadata" = ${value}::jsonb where "email" = ${"ada@x.test"}`,
        sql`update "User" set "metadata" = cast(${value} as jsonb) where "email" = ${"ada@x.test"}`,
      ]) {
        await DB.execute(fragment);
        expect((await metadataOf("ada@x.test")).kind).toBe(kind);
      }
    });

    /**
     * The two paths agree about what a `Json` column holds — which is the
     * property that makes raw SQL an escape hatch rather than a second
     * representation. The ORM writes the column through `fieldParam`'s
     * `::text::jsonb`; the raw filter finds that row through the same cast, now
     * that the caller's `::jsonb` means the same thing.
     */
    test("a raw jsonb filter matches a row the ORM wrote — postgres", async () => {
      if (!url) return;

      const document = { version: 1, tags: ["a"] };
      await Model.asSystem(async () => {
        await User.update({
          where: { email: "ada@x.test" },
          data: { metadata: document },
        });
      });

      const rows = await DB.query<{ email: string }>(
        sql`select "email" from "User"
            where "metadata" = ${JSON.stringify(document)}::jsonb`,
      );

      expect(rows.map((row) => row.email)).toEqual(["ada@x.test"]);
    });

    // --- the ambient transaction -----------------------------------------

    /**
     * The failure this guards is silent in every other test: a raw statement
     * that runs on a pooled connection commits while the transaction around it
     * rolls back, so the callback throws, the ORM's writes vanish, and the raw
     * one stays.
     */
    test("a raw write inside a transaction rolls back with it", async () => {
      await expect(
        Model.transaction(async () => {
          await DB.execute(sql`delete from "User" where "globalRole" = ${1}`);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await emails()).toHaveLength(3);
    });

    test("...and commits with it", async () => {
      await Model.transaction(async () => {
        await DB.execute(sql`delete from "User" where "globalRole" = ${1}`);
      });

      expect(await emails()).toEqual(["ada@x.test"]);
    });

    /**
     * The other direction, and the one that proves it is the *same* connection
     * rather than merely a second one that also committed: a raw read sees a
     * write the transaction has not committed yet. Nothing outside the
     * transaction can see it, so a `DB.query` on the pool would return two rows
     * here rather than three.
     */
    test("a raw read inside a transaction sees the transaction's own writes", async () => {
      await Model.asSystem(() =>
        Model.transaction(async () => {
          await User.create({ data: { email: "inside@x.test" } });

          const rows = await DB.query(
            sql`select "email" from "User" where "email" = ${"inside@x.test"}`,
          );
          expect(rows).toHaveLength(1);
        }),
      );

      expect(await emails()).toHaveLength(4);
    });

    test("a raw write inside a savepoint rolls back to it, leaving the outer alive", async () => {
      await Model.transaction(async () => {
        await expect(
          Model.transaction(async () => {
            await DB.execute(sql`delete from "User"`);
            throw new Error("inner");
          }),
        ).rejects.toThrow("inner");

        // The outer transaction is still usable, and the delete is gone.
        const rows = await DB.query(sql`select "id" from "User"`);
        expect(rows).toHaveLength(3);
      });

      expect(await emails()).toHaveLength(3);
    });

    // --- what did not change ---------------------------------------------

    test("DB.sql is untouched, and still Bun's own tagged template", async () => {
      const rows: any = await DB.sql`select "email" from "User" where "globalRole" = ${0}`;

      expect([...rows]).toHaveLength(1);
    });

    /**
     * **`DB.sql` does not join the ambient transaction**, which the docs state
     * and nothing asserted — only that the template still works.
     *
     * It is the consequential half. A write issued through it inside a
     * `Model.transaction` is on a different connection, so a rollback does not
     * take it back: the transaction reports failure and the row is still there.
     *
     * Worth pinning in both directions rather than as a caveat, because the two
     * calls look interchangeable at the call site and only one of them is safe
     * to mix with a transaction.
     */
    /**
     * **`DB.sql` and the ambient transaction — and the two dialects disagree.**
     *
     * `docs/orm.md` says it plainly and unconditionally: "It does **not** join
     * the ambient transaction — use `DB.query` when that matters."
     *
     * Measured, that holds on Postgres and **not** on SQLite. `DatabaseManager`
     * gives SQLite a single connection, so a `DB.sql` statement issued inside a
     * `Model.transaction` is on the same connection and therefore inside the
     * transaction — it rolls back with everything else. Postgres has a pool, so
     * the statement takes a different connection and escapes.
     *
     * The direction matters. A developer who tests on SQLite watches a `DB.sql`
     * write roll back correctly and ships it; on Postgres the rollback leaves
     * that write behind. It is the same hazard the transactions section already
     * warns about for a caught statement — "passes in development on SQLite and
     * takes out the transaction in production on Postgres" — reached by a
     * different door.
     *
     * Both halves are asserted per dialect rather than skipping the one that is
     * inconvenient: the point is that they genuinely differ.
     */
    test("whether a DB.sql write survives a rollback depends on the dialect", async () => {
      await expect(
        Model.transaction(async () => {
          await DB.sql`update "User" set "name" = ${"escaped"} where "email" = ${"ada@x.test"}`;
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      const after = await DB.query<{ name: string | null }>(
        sql`select "name" from "User" where "email" = ${"ada@x.test"}`,
      );

      if (url) {
        // Postgres: a different connection from the pool, so the transaction
        // never contained it and the rollback did not reach it.
        expect(after[0].name).toBe("escaped");
        await DB.execute(
          sql`update "User" set "name" = null where "email" = ${"ada@x.test"}`,
        );
      } else {
        // SQLite: one connection, so it was inside the transaction after all.
        expect(after[0].name).toBeNull();
      }
    });

    /**
     * ...and `DB.query` / `DB.execute`, which the docs point to instead, roll
     * back on **both**. Without this the test above says only that something
     * survived a failed transaction, which a transaction that never opened
     * would satisfy too.
     */
    test("a DB.execute write in the same place rolls back on either dialect", async () => {
      await expect(
        Model.transaction(async () => {
          await DB.execute(
            sql`update "User" set "name" = ${"joined"} where "email" = ${"ada@x.test"}`,
          );
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      const after = await DB.query<{ name: string | null }>(
        sql`select "name" from "User" where "email" = ${"ada@x.test"}`,
      );
      expect(after[0].name).not.toBe("joined");
    });

    test("a plain string is refused rather than run", async () => {
      await expect(
        DB.query(`select * from "User"` as never),
      ).rejects.toThrow(/built with 'sql'/);
    });
  });
}

suite("raw sql (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("raw sql (postgres)", POSTGRES_URL);
} else {
  describe("raw sql (postgres)", () => {
    // Loud rather than silent: the rowcount and the savepoint behaviour are
    // exactly the two things a SQLite pass proves nothing about.
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
