import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CrossConnectionTransactionError,
  DatabaseManager,
  UnknownConnectionError,
} from "gemi/database";
import { DB } from "gemi/facades";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, sql } from "gemi/orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { applyMigrations } from "./scratch";
import { User } from "./User";

/**
 * A second named connection, end to end (#327).
 *
 * The case it exists for is one database and two pools with opposite
 * workloads — a hot path that must never block behind a five-second dashboard
 * aggregate — so in production both connections usually hold the *same* URL and
 * differ only in `options`. That is exactly what a test cannot observe: two
 * pools onto one database are indistinguishable from one pool by looking at the
 * rows, which is the thing a test has to look at.
 *
 * So these run against **two SQLite files**. A statement that went to the wrong
 * connection lands in the wrong file, and the row is either there or it is not.
 * The pool split is asserted where it is observable — the manager's own
 * `connections.test.ts` in the framework — and the routing is asserted here,
 * where being wrong is a missing row rather than a slower one.
 *
 * SQLite only, and deliberately: nothing under test is dialect-specific
 * (the connection a statement runs on is resolved before a dialect is
 * consulted at all), and the Postgres scratch database is a single database
 * that could not tell the two connections apart.
 */
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

describe("named connections", () => {
  let workspace: string;
  let database: DatabaseManager;
  let previous: Application | undefined;

  /** Raw clients, so what a connection holds is read without going through it. */
  let hot: SQL;
  let analytics: SQL;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-orm-connections-"));
    const hotPath = join(workspace, "hot.db");
    const analyticsPath = join(workspace, "analytics.db");

    await applyMigrations(hotPath);
    await applyMigrations(analyticsPath);

    database = new DatabaseManager({
      url: `sqlite://${hotPath}`,
      connections: {
        analytics: {
          url: `sqlite://${analyticsPath}`,
          // The shape the issue describes: a small pool that may hold a
          // connection far longer than the hot path ever should.
          options: { max: 3 },
          slowTransactionThreshold: 60_000,
        },
      },
    });

    hot = new SQL(`sqlite://${hotPath}`);
    analytics = new SQL(`sqlite://${analyticsPath}`);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
  }, 120_000);

  afterAll(async () => {
    await hot?.close();
    await analytics?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearPlanCache();
    for (const client of [hot, analytics]) {
      for (const table of TABLES) await client.unsafe(`DELETE FROM "${table}"`);
    }
  });

  /** Emails, since `id` restarts from 1 in both files and cannot tell them apart. */
  const emails = async (client: SQL) =>
    (
      (await client.unsafe(
        `select "email" from "User" order by "email"`,
      )) as any[]
    ).map((row) => row.email);

  test("a query without a connection goes to the default one", async () => {
    await User.create({ data: { email: "hot@example.dev" } });

    expect(await emails(hot)).toEqual(["hot@example.dev"]);
    expect(await emails(analytics)).toEqual([]);
  });

  test("a query naming one goes there instead", async () => {
    await User.on("analytics").create({
      data: { email: "analytics@example.dev" },
    });

    expect(await emails(analytics)).toEqual(["analytics@example.dev"]);
    expect(await emails(hot)).toEqual([]);
  });

  /**
   * The property the issue asks for in as many words: *which connection a model
   * uses is a per-query property, not a per-model one*. The same class, two
   * queries, two databases — which a `static connection = "analytics"` on the
   * model could not express, because the same `Subscription` is read on the hot
   * path during sign-in and swept by the nightly audit.
   */
  test("the same model reads from both, per query", async () => {
    await hot.unsafe(
      `insert into "User" ("publicId", "email", "createdAt", "updatedAt")
       values ('p-hot', 'hot@example.dev', 0, 0)`,
    );
    await analytics.unsafe(
      `insert into "User" ("publicId", "email", "createdAt", "updatedAt")
       values ('p-cold', 'cold@example.dev', 0, 0)`,
    );

    expect((await User.findMany({})).map((row) => row.email)).toEqual([
      "hot@example.dev",
    ]);
    expect(
      (await User.on("analytics").findMany({})).map((row) => row.email),
    ).toEqual(["cold@example.dev"]);
  });

  /**
   * The failure a per-call argument could not have prevented.
   *
   * A relation read recurses through the *target* model's `$exec`, resolved out
   * of the registry — so unless the connection travels in the ambient scope,
   * the root row comes from the analytics file and its `accounts` come from the
   * hot one. Both files hold a user and an account here, differing only in the
   * value under test, so a leak is a wrong row rather than a missing one.
   */
  test("an include reads its relation on the same connection", async () => {
    for (const [client, label] of [
      [hot, "hot"],
      [analytics, "cold"],
    ] as const) {
      await client.unsafe(
        `insert into "User" ("id", "publicId", "email", "createdAt", "updatedAt")
         values (1, 'p-${label}', '${label}@example.dev', 0, 0)`,
      );
      await client.unsafe(
        `insert into "Account" ("id", "publicId", "userId", "organizationRole", "createdAt", "updatedAt")
         values (1, 'a-${label}', 1, 2, 0, 0)`,
      );
    }

    const rows = await User.on("analytics").findMany({
      include: { accounts: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].accounts.map((account: any) => account.publicId)).toEqual([
      "a-cold",
    ]);
  });

  test("a nested write lands entirely on the named connection", async () => {
    await User.on("analytics").create({
      data: {
        email: "nested@example.dev",
        accounts: { create: [{ organizationRole: 2 }] },
      },
    });

    const there = (await analytics.unsafe(
      `select count(*) as c from "Account"`,
    )) as any;
    const here = (await hot.unsafe(
      `select count(*) as c from "Account"`,
    )) as any;

    expect(there[0].c).toBe(1);
    expect(here[0].c).toBe(0);
  });

  /**
   * Never a fall back to the default. A typo that quietly ran the analytics
   * sweep on the hot path would produce exactly the incident the second pool
   * was configured to prevent, weeks later, with nothing pointing at the typo.
   */
  test("an unknown connection raises rather than falling back", async () => {
    await expect(User.on("analitycs").findMany({})).rejects.toThrow(
      UnknownConnectionError,
    );

    expect(await emails(hot)).toEqual([]);
  });

  test("the bound class is the same object every time", () => {
    expect(User.on("analytics")).toBe(User.on("analytics"));
    expect(User.on("analytics")).not.toBe(User.on("default"));
    expect(User.on("analytics").name).toBe(User.name);
  });

  describe("transactions", () => {
    test("one on a named connection rolls back there", async () => {
      await expect(
        User.on("analytics").transaction(async () => {
          await User.on("analytics").create({
            data: { email: "rolled@example.dev" },
          });
          throw new Error("no");
        }),
      ).rejects.toThrow("no");

      expect(await emails(analytics)).toEqual([]);
    });

    /**
     * The ordinary case, and the reason an unqualified query inherits the
     * connection instead of resolving to the default one: inside a transaction
     * on `analytics`, a bare `User.create` has to join *that* transaction. If
     * it resolved to the default connection it would be refused as a
     * cross-connection statement, which would make the handle unusable for
     * everything except explicitly-named queries.
     */
    test("an unqualified query inside one joins it", async () => {
      await expect(
        DB.connection("analytics").transaction(async () => {
          await User.create({ data: { email: "inherited@example.dev" } });
          await DB.execute(
            sql`update "User" set "name" = ${"changed"} where "email" = ${"inherited@example.dev"}`,
          );
          throw new Error("no");
        }),
      ).rejects.toThrow("no");

      // Rolled back on the connection the transaction was open on, and never
      // present on the other one.
      expect(await emails(analytics)).toEqual([]);
      expect(await emails(hot)).toEqual([]);
    });

    test("...and commits there when it does not throw", async () => {
      await DB.connection("analytics").transaction(async () => {
        await User.create({ data: { email: "committed@example.dev" } });
      });

      expect(await emails(analytics)).toEqual(["committed@example.dev"]);
      expect(await emails(hot)).toEqual([]);
    });

    /**
     * The refusal, which is the half of this feature that is a *decision*.
     *
     * A transaction lives on one reserved connection; the other pool's
     * statement cannot join it and cannot be rolled back with it. So it is
     * refused at the call rather than run outside the transaction, where it
     * would stay committed while everything around it rolled back.
     */
    test("a model query naming another connection is refused", async () => {
      await expect(
        Model.transaction(async () => {
          await User.create({ data: { email: "kept@example.dev" } });
          await User.on("analytics").create({
            data: { email: "refused@example.dev" },
          });
        }),
      ).rejects.toThrow(CrossConnectionTransactionError);

      // The refusal took the transaction down with it, as an uncaught error in
      // a transaction should — so neither row survives, on either connection.
      expect(await emails(hot)).toEqual([]);
      expect(await emails(analytics)).toEqual([]);
    });

    /**
     * The same for raw SQL, and this is the one that would have hurt most.
     * `DB.execute` is a statement with no model behind it, so nothing else in
     * the pipeline would have looked at which connection it was about to run
     * on.
     */
    test("a raw statement naming another connection is refused", async () => {
      await expect(
        Model.transaction(async () => {
          await DB.connection("analytics").execute(
            sql`insert into "User" ("publicId", "email", "createdAt", "updatedAt")
                values (${"p"}, ${"raw@example.dev"}, ${0}, ${0})`,
          );
        }),
      ).rejects.toThrow(CrossConnectionTransactionError);

      expect(await emails(analytics)).toEqual([]);
    });

    /**
     * Catching it leaves the transaction usable, which is what makes the error
     * something an application can act on: the analytics work moves outside the
     * transaction, and the hot-path work still commits.
     */
    test("catching the refusal leaves the transaction intact", async () => {
      let refused: unknown;

      await Model.transaction(async () => {
        await User.create({ data: { email: "kept@example.dev" } });
        try {
          await User.on("analytics").findMany({});
        } catch (error) {
          refused = error;
        }
      });

      expect(refused).toBeInstanceOf(CrossConnectionTransactionError);
      expect(await emails(hot)).toEqual(["kept@example.dev"]);
    });
  });

  /**
   * `save` writes back to the connection the row was read on.
   *
   * The one piece of connection state that cannot be ambient: a tracked row is
   * an ordinary object that outlives the scope that produced it, so by the time
   * it is saved the scope is gone. It was reported in review, and the failure it
   * produced is the worst shape available here — `save` compiled a correct
   * `update` and sent it to the *other* database, where in production the same
   * id names a real and different row. No error, one wrong row.
   */
  describe("save", () => {
    beforeEach(async () => {
      for (const [client, label] of [
        [hot, "hot"],
        [analytics, "cold"],
      ] as const) {
        await client.unsafe(
          `insert into "User" ("id", "publicId", "name", "email", "createdAt", "updatedAt")
           values (1, 'p-${label}', '${label}-original', '${label}@example.dev', 0, 0)`,
        );
      }
    });

    const names = async (client: SQL) =>
      ((await client.unsafe(`select "name" from "User"`)) as any[]).map(
        (row) => row.name,
      );

    test("a row read on a named connection is saved back to it", async () => {
      const [row] = await User.on("analytics").findMany({}, { track: true });
      row.name = "written-by-save";

      await User.save(row);

      expect(await names(analytics)).toEqual(["written-by-save"]);
      expect(await names(hot)).toEqual(["hot-original"]);
    });

    test("...including from an instance `wrap` built", async () => {
      const [row] = await User.on("analytics").findMany({}, { track: true });
      const user = User.wrap(row);
      user.name = "written-by-wrap";

      await user.save();

      expect(await names(analytics)).toEqual(["written-by-wrap"]);
      expect(await names(hot)).toEqual(["hot-original"]);
    });

    test("naming a different connection is a contradiction, and raises", async () => {
      const [row] = await User.on("analytics").findMany({}, { track: true });
      row.name = "written-by-save";

      await expect(User.on("default").save(row)).rejects.toThrow(
        /read on the "analytics" connection and this save names "default"/,
      );

      expect(await names(hot)).toEqual(["hot-original"]);
      expect(await names(analytics)).toEqual(["cold-original"]);
    });

    /**
     * The update cannot join a transaction on another connection, so it must
     * not run at all — the same refusal every other statement gets, reached
     * through the one path that carries its connection in data.
     */
    test("saving into a transaction on another connection is refused", async () => {
      const [row] = await User.on("analytics").findMany({}, { track: true });
      row.name = "written-by-save";

      await expect(
        Model.transaction(async () => {
          await User.save(row);
        }),
      ).rejects.toThrow(CrossConnectionTransactionError);

      expect(await names(analytics)).toEqual(["cold-original"]);
    });

    test("an ordinary save still goes to the default connection", async () => {
      const [row] = await User.findMany({}, { track: true });
      row.name = "written-by-save";

      await User.save(row);

      expect(await names(hot)).toEqual(["written-by-save"]);
      expect(await names(analytics)).toEqual(["cold-original"]);
    });
  });

  describe("raw SQL", () => {
    test("runs on the connection the handle names", async () => {
      await analytics.unsafe(
        `insert into "User" ("publicId", "email", "createdAt", "updatedAt")
         values ('p-cold', 'cold@example.dev', 0, 0)`,
      );

      const rows = await DB.connection("analytics").query<{ email: string }>(
        sql`select "email" from "User"`,
      );
      expect(rows.map((row) => row.email)).toEqual(["cold@example.dev"]);

      // The unqualified facade is still the default connection. Length rather
      // than `toEqual([])`: Bun hangs `count` and `command` off the array it
      // returns, so an empty result is not deeply equal to a plain `[]`.
      expect(await DB.query(sql`select "email" from "User"`)).toHaveLength(0);
    });

    test("the handle carries the connection's own dialect", () => {
      expect(DB.connection("analytics").dialect).toBe("sqlite");
      expect(DB.connection("analytics").name).toBe("analytics");
      expect(DB.connection("analytics").sql).not.toBe(DB.sql);
    });

    test("an unknown connection raises there too", async () => {
      await expect(
        DB.connection("analitycs").query(sql`select 1`),
      ).rejects.toThrow(UnknownConnectionError);
    });
  });
});
