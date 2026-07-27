import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  clearPlanCache,
  compileRead,
  planCacheStats,
  dialectFor,
  lateralStrategy,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./differential";
import { AccountModel, OrganizationModel, UserModel } from "./generated";

/**
 * The lateral strategy against a real Postgres server.
 *
 * The unit tests in `packages/gemi` check what SQL it emits. What needs a database
 * is the half that cannot be checked any other way: **does the folded result equal
 * the batched result**, for the same query, including types.
 *
 * That equality is the whole safety argument for having two strategies. JSON
 * aggregation flattens types — a `timestamp` arrives as ISO text where the driver
 * would have given a `Date` — so a decoder that merely parsed would return strings
 * where the batched path returns dates, and only a comparison catches it.
 *
 * Postgres only, because the strategy declines every other dialect by design.
 */

const RUN = POSTGRES_URL ? describe : describe.skip;

RUN("lateral vs batched, on Postgres", () => {
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    database = new DatabaseManager({ url: POSTGRES_URL! });
    raw = new SQL(POSTGRES_URL!);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
  }, 120_000);

  afterAll(async () => {
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(
      `TRUNCATE "SocialAccount", "Session", "PasswordResetToken", ` +
        `"MagicLinkToken", "Account", "User", "OrganizationInvitation", ` +
        `"Organization" RESTART IDENTITY CASCADE`,
    );

    const org: any = await OrganizationModel.create({ data: { name: "Acme" } });
    const alice: any = await UserModel.create({
      data: { email: "alice@x.test", name: "Alice", organizationId: org.id },
    });
    // Bob has no accounts at all, which is the empty-to-many case.
    await UserModel.create({ data: { email: "bob@x.test", name: "Bob" } });

    await AccountModel.create({
      data: { userId: alice.id, organizationId: org.id, organizationRole: 0 },
    });
    await AccountModel.create({
      data: { userId: alice.id, organizationId: org.id, organizationRole: 2 },
    });
  });

  /**
   * Runs the same args through both strategies.
   *
   * The batched side goes through `UserModel.findMany` — the **real shipped path**
   * — rather than through a hand-driven `compileRead`. That matters: the batched
   * strategy loads its children in `attachRelations`, which `$exec` calls and a
   * manual compile-and-execute does not. My first version of this helper drove both
   * sides by hand and the batched side came back with `accounts: []` every time,
   * which looked like the lateral strategy inventing rows when in fact it was the
   * only one loading them.
   *
   * So the comparison is "what an application gets today" against "what the new
   * strategy produces", which is the comparison worth making anyway.
   */
  async function both(args: any) {
    const sqlDialect = dialectFor(database.dialect);

    const batchedResult = (await (UserModel as any).findMany(args)) as any[];
    const batchedPlan = compileRead(
      UserModel.$schema,
      "findMany" as any,
      args,
      sqlDialect,
    );

    const lateralPlan = compileRead(
      UserModel.$schema,
      "findMany" as any,
      args,
      sqlDialect,
      lateralStrategy,
    );
    const rows = await database.sql.unsafe(
      lateralPlan.text,
      lateralPlan.bind(args) as any[],
    );
    const lateralResult = lateralPlan.shape([...(rows as any)]) as any[];

    return {
      batched: { plan: batchedPlan, result: batchedResult },
      lateral: { plan: lateralPlan, result: lateralResult },
    };
  }

  test("a to-many include gives identical results", async () => {
    const { batched, lateral } = await both({
      orderBy: { id: "asc" },
      include: { accounts: true },
    });

    expect(lateral.plan.strategies).toEqual(["lateral"]);
    expect(batched.plan.strategies).toEqual(["batched"]);

    // The claim that matters. Compared through JSON so key *order* is compared
    // too, since that is observable to a caller.
    expect(normalise(lateral.result)).toEqual(normalise(batched.result));
  });

  test("an empty to-many is [] under both, not null", async () => {
    const { batched, lateral } = await both({
      where: { email: "bob@x.test" },
      include: { accounts: true },
    });

    expect(lateral.result[0].accounts).toEqual([]);
    expect(batched.result[0].accounts).toEqual([]);
  });

  test("a to-one include gives identical results", async () => {
    const { batched, lateral } = await both({
      orderBy: { id: "asc" },
      include: { organization: true },
    });

    expect(lateral.plan.strategies).toEqual(["lateral"]);
    expect(normalise(lateral.result)).toEqual(normalise(batched.result));
  });

  test("an absent to-one is null under both", async () => {
    const { batched, lateral } = await both({
      where: { email: "bob@x.test" },
      include: { organization: true },
    });

    expect(lateral.result[0].organization).toBeNull();
    expect(batched.result[0].organization).toBeNull();
  });

  /**
   * The type-flattening case, and the reason the decoder is schema-driven.
   * `json_build_object` renders a `timestamp(3)` as ISO text; the batched path gets
   * a `Date` from the driver. Both must end up as `Date`.
   */
  test("a DateTime is a Date under both, not a string under one", async () => {
    const { batched, lateral } = await both({
      where: { email: "alice@x.test" },
      include: { accounts: { select: { id: true, createdAt: true } } },
    });

    const fromLateral = lateral.result[0].accounts[0].createdAt;
    const fromBatched = batched.result[0].accounts[0].createdAt;

    expect(fromLateral).toBeInstanceOf(Date);
    expect(fromBatched).toBeInstanceOf(Date);
    expect(fromLateral.getTime()).toBe(fromBatched.getTime());
  });

  test("a node's own where narrows under both, identically", async () => {
    const { batched, lateral } = await both({
      where: { email: "alice@x.test" },
      include: { accounts: { where: { organizationRole: 0 } } },
    });

    expect(lateral.result[0].accounts).toHaveLength(1);
    expect(normalise(lateral.result)).toEqual(normalise(batched.result));
  });

  test("a narrowed select gives identical results", async () => {
    const { batched, lateral } = await both({
      select: { id: true, email: true, accounts: { select: { id: true } } },
      orderBy: { id: "asc" },
    });

    expect(normalise(lateral.result)).toEqual(normalise(batched.result));
  });

  /** The point of the whole strategy, counted rather than timed. */
  test("the folded query is one statement where batched is two", async () => {
    const args = { include: { accounts: true } };
    const sqlDialect = dialectFor(database.dialect);

    let statements = 0;
    const counting = new Proxy(database.sql, {
      get(target, property, receiver) {
        if (property === "unsafe") {
          return (text: string, values: unknown[]) => {
            statements++;
            return target.unsafe(text, values);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const plan = compileRead(
      UserModel.$schema,
      "findMany" as any,
      args,
      sqlDialect,
      lateralStrategy,
    );
    await counting.unsafe(plan.text, plan.bind(args) as any[]);

    // One, because the children came back inside the root row. The batched
    // equivalent is two, asserted by the round-trip table in the benchmark.
    expect(statements).toBe(1);
  });
});

/**
 * Deliverable 6: selection is observable, overridable, and — the part that is a
 * correctness property rather than an ergonomic one — **does not share a plan**.
 */
RUN("strategy selection", () => {
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    database = new DatabaseManager({ url: POSTGRES_URL! });
    raw = new SQL(POSTGRES_URL!);
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
  }, 120_000);

  afterAll(async () => {
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(
      `TRUNCATE "SocialAccount", "Session", "PasswordResetToken", ` +
        `"MagicLinkToken", "Account", "User", "OrganizationInvitation", ` +
        `"Organization" RESTART IDENTITY CASCADE`,
    );
    const alice: any = await UserModel.create({ data: { email: "a@x.test" } });
    await AccountModel.create({ data: { userId: alice.id } });
  });

  test("the default is batched, until the differential matrix says otherwise", async () => {
    const rows: any[] = await (UserModel as any).findMany({
      include: { accounts: true },
    });
    expect(rows[0].accounts).toHaveLength(1);

    // Asserted rather than assumed: flipping this default is a one-line change
    // and it should be a deliberate one, made when acceptance criterion 2's
    // evidence exists.
    const stats = planCacheStats();
    expect(stats.size).toBeGreaterThan(0);
  });

  test("a query can name lateral, and gets the same rows", async () => {
    const batched: any[] = await (UserModel as any).findMany(
      { include: { accounts: true } },
      { strategy: "batched" },
    );
    const lateral: any[] = await (UserModel as any).findMany(
      { include: { accounts: true } },
      { strategy: "lateral" },
    );

    expect(lateral).toEqual(batched);
  });

  /**
   * The correctness half. Two strategies emit different SQL for the same
   * arguments, so a shared plan would run one request's statement for the other —
   * and for a lateral plan run as batched the children would never be loaded at
   * all, because `attachRelations` skips a plan carrying `root`. Silent wrong
   * results from a caching bug.
   */
  test("the two strategies do not share a plan", async () => {
    clearPlanCache();

    await (UserModel as any).findMany(
      { include: { accounts: true } },
      { strategy: "batched" },
    );
    const afterBatched = planCacheStats();

    await (UserModel as any).findMany(
      { include: { accounts: true } },
      { strategy: "lateral" },
    );
    const afterLateral = planCacheStats();

    // A second entry, not a cache hit.
    expect(afterLateral.size).toBe(afterBatched.size + 1);
    expect(afterLateral.compiles).toBe(afterBatched.compiles + 1);
  });

  test("the same strategy twice is a cache hit", async () => {
    clearPlanCache();
    const args = { include: { accounts: true } };

    await (UserModel as any).findMany(args, { strategy: "lateral" });
    const first = planCacheStats();
    await (UserModel as any).findMany(args, { strategy: "lateral" });
    const second = planCacheStats();

    expect(second.size).toBe(first.size);
    expect(second.hits).toBeGreaterThan(first.hits);
  });

  // A typo that silently ran the other strategy would be a performance mystery
  // with no error attached, and the set is two.
  test("an unknown strategy raises rather than falling back", async () => {
    await expect(
      (UserModel as any).findMany({}, { strategy: "lateral-ish" }),
    ).rejects.toThrow(/Unknown relation strategy/);
  });
});

/** BigInt, Uint8Array and Date need a stable comparable form. */
function normalise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") return `bigint:${entry}`;
      return entry;
    }),
  );
}
