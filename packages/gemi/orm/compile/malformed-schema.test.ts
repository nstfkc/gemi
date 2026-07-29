import { beforeEach, describe, expect, test } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import {
  MalformedRelationError,
  MissingModelSchemaError,
  MissingRequiredValueError,
  ReturningUnsupportedError,
  UnknownFieldError,
  UnregisteredRelationTargetError,
} from "../errors";
import { account, organization, post, tag, user } from "../fixtures";
import { Model } from "../Model";
import * as registry from "../registry";
import { compileRead } from "./read";
import { compileWrite } from "./write";

const sqlite = new SqliteDialect();

/**
 * The construction sites nothing reached, across the **other** 16 error classes.
 *
 * #114 measured `UnsupportedQueryError` only, and #118 closed it at 0 unreached
 * — but `errors.ts` declares 18 classes. Instrumenting all of them (every one
 * ends with `this.name = "..."`, so one substitution reaches them all) gives
 * **188 sites, 14 unreached** (#119).
 *
 * Most of them are `MalformedRelationError`, and those are a different animal
 * from the shape guards in `refusals.test.ts`. They do not guard caller input:
 * they guard the **generated artifact**, so nothing that goes through the
 * public API can reach one. Testing them means building a deliberately broken
 * schema, which is also what makes them worth testing — an author who hits one
 * has a stale artifact and the message is the entire diagnosis.
 */
describe("a malformed generated artifact", () => {
  const register = (pairs: [string, unknown][]) => {
    registry.clearRegistry();
    for (const [name, schema] of pairs) {
      registry.register(name, class { static $schema = schema });
    }
  };

  beforeEach(() => registry.clearRegistry());

  /** `Account.user.from` naming a column `Account` does not declare. */
  test("a link naming a column that is not there", () => {
    const broken = {
      ...account,
      relations: {
        ...account.relations,
        user: { ...account.relations.user, from: ["nosuchcol"] },
      },
    };
    register([["User", user], ["Account", broken]]);

    expect(() =>
      compileRead(
        user,
        "findMany",
        { where: { accounts: { some: { id: 1 } } } } as never,
        sqlite,
      ),
    ).toThrow(MalformedRelationError);
    expect(() =>
      compileRead(
        user,
        "findMany",
        { where: { accounts: { some: { id: 1 } } } } as never,
        sqlite,
      ),
    ).toThrow(/joins on 'nosuchcol', which is not a field on Account/);
  });

  /** Both sides with an empty `from` — a link with no key on either end. */
  test("neither side holding the foreign key", () => {
    const orphan = {
      ...account,
      relations: {
        ...account.relations,
        user: { ...account.relations.user, from: [], to: [] },
      },
    };
    register([["User", user], ["Account", orphan]]);

    expect(() =>
      compileWrite(
        user,
        "update",
        { where: { id: 1 }, data: { accounts: { connect: { id: 1 } } } } as never,
        sqlite,
      ),
    ).toThrow(/neither User.accounts nor Account.user holds the foreign key/);
  });

  // The opposing relation is found by `relationName`, so both "none" and "more
  // than one" are the same failure: the planner cannot tell which side it is
  // looking at.
  test.each([
    [
      "no opposing relation",
      { ...account, relations: {} },
      /Account declares no relation named 'AccountToUser'/,
    ],
    [
      "two opposing relations",
      {
        ...account,
        relations: {
          ...account.relations,
          user: { ...account.relations.user, from: [], to: [] },
          user2: {
            name: "user2",
            model: "User",
            kind: "one" as const,
            relationName: "AccountToUser",
            from: [],
            to: [],
            nullable: true,
          },
        },
      },
      /Account declares 2 relations named/,
    ],
  ])("%s", (_label, broken, message) => {
    register([["User", user], ["Account", broken]]);

    expect(() =>
      compileRead(user, "findMany", { include: { accounts: true } } as never, sqlite),
    ).toThrow(message);
  });

  /**
   * An implicit many-to-many joins each end on its primary key, so an end with
   * a composite one has no single column to put in the join table.
   */
  test("a composite primary key on an implicit many-to-many", () => {
    register([["Post", post], ["Tag", { ...tag, primaryKey: ["id", "name"] }]]);

    expect(() =>
      compileRead(post, "findMany", { include: { tags: true } } as never, sqlite),
    ).toThrow(/joins on Tag's primary key, which has 2 fields/);
  });

  // ...and a primary key of the right *shape* naming a field that is not there.
  test.each([
    ["the child's", (): [string, unknown][] => [["Post", post], ["Tag", { ...tag, primaryKey: ["nosuch"] }]], post],
    ["the parent's", (): [string, unknown][] => [["Post", { ...post, primaryKey: ["nosuch"] }], ["Tag", tag]], { ...post, primaryKey: ["nosuch"] }],
  ])("a primary key naming a field that is not there — %s", (_label, pairs, from) => {
    register(pairs());

    expect(() =>
      compileRead(from as never, "findMany", { include: { tags: true } } as never, sqlite),
    ).toThrow(/joins on 'nosuch', which is not a field on/);
  });

  /**
   * A join table naming two models, neither of them the one being planned.
   *
   * Distinct from the composite-key case above: the *shape* is fine, it just
   * describes a different pair of models than the relation it hangs off.
   */
  test("a join table connecting neither end", () => {
    const strayed = {
      ...post,
      relations: {
        ...post.relations,
        tags: {
          ...post.relations.tags,
          joinTable: { table: "_XToY", a: "X", b: "Y" },
        },
      },
    };
    register([["Post", strayed], ["Tag", tag]]);

    expect(() =>
      compileRead(strayed as never, "findMany", { include: { tags: true } } as never, sqlite),
    ).toThrow(/the join table '_XToY' connects X and Y, neither of which is Post/);
  });

  /**
   * **A declared unique naming a missing field is pre-empted**, which is why
   * nothing reached `fieldOf` (`write.ts:1315`).
   *
   * Its only callers build `upsert`'s `on conflict` target — the one place a
   * *key's* members become columns rather than being matched against the
   * caller's `where`. Two checks get there first, and between them they leave
   * no path:
   *
   *   - `write.ts:645` refuses a `where` selecting on a key the `create` does
   *     not set, which is what the case below hits;
   *   - satisfying that means putting the phantom name in `create`, and the
   *     create-data compiler refuses it as an unknown field.
   *
   * Fourth instance of this shape, after `select.ts:28` (#115),
   * `parseOrderBy`'s relation guard (#118) and `registry.get` below. A floor,
   * not dead code — and pinned here so the next reader does not re-derive it.
   */
  test("a unique naming a field that is not there is caught before the key is built", () => {
    const broken = { ...user, uniques: [["nosuch"]] };
    register([["User", broken]]);

    // The `on conflict` target is never reached: the upsert's own
    // key-must-be-in-create check answers first.
    expect(() =>
      compileWrite(
        broken as never,
        "upsert",
        {
          where: { nosuch: 1 },
          create: { email: "a@b.c" },
          update: { name: "x" },
        } as never,
        sqlite,
      ),
    ).toThrow(/where clause selects on nosuch, but 'create' does not set/);

    // ...and the only way to satisfy that one runs into the other.
    expect(() =>
      compileWrite(
        broken as never,
        "upsert",
        {
          where: { nosuch: 1 },
          create: { nosuch: 1, email: "a@b.c" },
          update: { name: "x" },
        } as never,
        sqlite,
      ),
    ).toThrow(UnknownFieldError);
  });

  /**
   * A registered model with no `$schema` — a subclass that did not extend a
   * generated base. Both the model's own accessor and the relation planner's
   * lookup answer for it, and they are separate call sites.
   */
  test("a registered model with no $schema", () => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Account", class {});

    expect(() =>
      compileRead(user, "findMany", { include: { accounts: true } } as never, sqlite),
    ).toThrow(MissingModelSchemaError);
  });

  test("a Model subclass with no $schema", () => {
    class Detached extends Model {}
    expect(() => Detached.$modelSchema()).toThrow(MissingModelSchemaError);
  });

  /**
   * **`ModelNotRegisteredError` is pre-empted**, which is why nothing reached
   * `registry.ts:29`.
   *
   * `relatedSchema` asks `registry.has` first and raises
   * `UnregisteredRelationTargetError`, which names the parent, the relation and
   * what *is* registered — strictly more than `registry.get`'s version. So the
   * blunter one is a floor under a direct `registry.get`, not dead code. Third
   * instance of this shape, after `select.ts:28` (#115) and `parseOrderBy`'s
   * relation guard (#118).
   */
  test("an unregistered relation target names the relation, not just the model", () => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });

    let error: UnregisteredRelationTargetError | null = null;
    try {
      compileRead(user, "findMany", { include: { accounts: true } } as never, sqlite);
    } catch (raised) {
      error = raised as UnregisteredRelationTargetError;
    }

    expect(error).toBeInstanceOf(UnregisteredRelationTargetError);
    expect(error!.relation).toBe("accounts");
    expect(error!.target).toBe("Account");
    // ...and `registry.get`'s own guard still answers when called directly.
    expect(() => registry.get("Nope")).toThrow(/Nope/);
  });
});

/**
 * The remaining four, which do guard caller input — or, in one case, a dialect.
 */
describe("the other unreached guards", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Organization", class { static $schema = organization });
  });

  test.each([
    [
      "a createMany row names an unknown field",
      () => compileWrite(user, "createMany", { data: [{ nope: 1 }] } as never, sqlite),
    ],
    [
      "an update names an unknown field",
      () => compileWrite(user, "update", { where: { id: 1 }, data: { nope: 1 } } as never, sqlite),
    ],
    [
      "an omit names an unknown field",
      () => compileRead(user, "findMany", { omit: { nope: true } } as never, sqlite),
    ],
  ])("%s", (_label, run) => {
    expect(run).toThrow(UnknownFieldError);
  });

  /**
   * `createMany` is one statement, so a row missing a required value cannot be
   * filled in from another row's. The report names *which* row.
   */
  test("a createMany row omits a required value", () => {
    let error: MissingRequiredValueError | null = null;
    try {
      compileWrite(
        organization,
        "createMany",
        { data: [{ name: "a" }, {}] } as never,
        sqlite,
      );
    } catch (raised) {
      error = raised as MissingRequiredValueError;
    }

    expect(error).toBeInstanceOf(MissingRequiredValueError);
    expect(error!.message).toMatch(/createMany\.data\[1\]/);
    expect(error!.message).toMatch(/'name'/);
  });

  /**
   * **Unreachable by design today**, and the only guard here that is.
   *
   * Both dialects support `RETURNING`. The check exists so MySQL is a named gap
   * rather than a silent one — its own comment says so — which means the honest
   * way to reach it is a stub dialect rather than inventing a third real one.
   */
  test("a dialect without RETURNING is refused by name", () => {
    const mysql = { ...sqlite, name: "mysql", supportsReturning: false };

    let error: ReturningUnsupportedError | null = null;
    try {
      compileWrite(user, "create", { data: { email: "a@b.c" } } as never, mysql as never);
    } catch (raised) {
      error = raised as ReturningUnsupportedError;
    }

    expect(error).toBeInstanceOf(ReturningUnsupportedError);
    expect(error!.message).toMatch(/User\.create needs RETURNING/);
    expect(error!.message).toMatch(/mysql/);
  });
});
