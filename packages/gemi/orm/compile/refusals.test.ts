import { beforeEach, describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import {
  account,
  membership,
  organization,
  post,
  profile,
  tag,
  userWithProfile,
} from "../fixtures";
import * as registry from "../registry";
import { compileAggregate } from "./aggregate";
import { compileGroupBy } from "./group-by";
import { compile } from "./index";
import { lateralStrategy } from "./lateral";
import { parseOrderBy } from "./orderBy";
import { compileRead } from "./read";
import { compileWrite } from "./write";

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

/**
 * The refusals nothing reached.
 *
 * #114 instrumented `UnsupportedQueryError`'s constructor, ran both suites, and
 * diffed the recorded call sites against every construction site in `orm/`:
 * **145 sites, 36 never constructed**. `select.ts`'s eight were taken in #115
 * and `nested-writes.ts`'s `kind` guard led to #116; this is the remaining 36.
 *
 * Every one is a shape guard — the argument is the wrong *type* rather than
 * naming something unknown, which is why the ordinary tests miss them: they
 * pass well-formed arguments. Triaged by building an input for each and reading
 * the construction site off the error's own stack.
 *
 * **35 are reachable and answer correctly.** No defect. Worth saying plainly
 * rather than implying a haul — the value is that they are pinned now, and the
 * three defects #114 was filed off the back of are the argument for pinning
 * them. The 36th has its own case at the bottom.
 *
 * Asserted on `argument` rather than the message text, because `argument` is
 * what identifies which guard fired — several share a message.
 */
describe("shape guards", () => {
  beforeEach(() => {
    registry.clearRegistry();
    for (const [name, schema] of [
      ["User", userWithProfile],
      ["Account", account],
      ["Organization", organization],
      ["Post", post],
      ["Tag", tag],
      ["Profile", profile],
      ["Membership", membership],
    ] as const) {
      registry.register(name, class { static $schema = schema });
    }
  });

  const refusal = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (error) {
      return error as UnsupportedQueryError;
    }
  };

  const read = (args: unknown, op = "findMany") => () =>
    compileRead(userWithProfile, op as never, args as never, sqlite);
  const write = (args: unknown, op = "update") => () =>
    compileWrite(userWithProfile, op as never, args as never, sqlite);
  const groupBy = (args: unknown) => () =>
    compileGroupBy(userWithProfile, "groupBy" as never, args as never, sqlite);

  // [what it guards, the query, the `argument` it reports, a fragment of why]
  const CASES: [string, () => unknown, string, RegExp][] = [
    // --- ordering ---------------------------------------------------------
    ["orderBy is not an object", read({ orderBy: 5 }), "orderBy", /Expected an object or an array of objects/],
    [
      "orderBy long form has an unknown nulls",
      read({ orderBy: { name: { sort: "asc", nulls: "sideways" } } }),
      `orderBy.name.nulls: "sideways"`,
      /Expected "first" or "last"/,
    ],
    ["orderBy value is neither form", read({ orderBy: { name: 5 } }), "orderBy.name", /Expected "asc", "desc", or \{ sort, nulls \}/],
    [
      "a relation _count orders by neither direction",
      read({ orderBy: { accounts: { _count: { sort: "sideways" } } } }),
      "orderBy.accounts._count",
      /Expected "asc" or "desc"/,
    ],
    [
      "a relation _count has an unknown nulls",
      read({ orderBy: { accounts: { _count: { sort: "asc", nulls: "x" } } } }),
      "orderBy.accounts._count.nulls",
      /Expected "first" or "last"/,
    ],

    // --- where ------------------------------------------------------------
    ["where is an array", read({ where: [1] }), "where", /Expected an object/],
    [
      "a compound key's value is not an object",
      () => compileRead(membership, "findUnique" as never, { where: { organizationId_userId: 5 } } as never, sqlite),
      "where.organizationId_userId",
      /Expected an object holding organizationId and userId/,
    ],
    ["mode is neither default nor insensitive", read({ where: { name: { contains: "a", mode: "weird" } } }), `mode: "weird"`, /./],
    ["in is not an array", read({ where: { name: { in: "notarray" } } }), "where.name.in", /Expected an array/],

    // --- groupBy ----------------------------------------------------------
    ["by is not a name or a list", groupBy({ by: 5, _count: true }), "by", /Expected a field name or an array of them/],
    ["by holds something that is not a name", groupBy({ by: [5], _count: true }), "by", /Expected field names/],
    ["having is not an object", groupBy({ by: ["name"], having: [1] }), "having", /Expected an object of field filters/],
    ["groupBy orderBy holds a non-object", groupBy({ by: ["name"], orderBy: [5] }), "orderBy", /Expected an object of fields, or an array of them/],
    ["an aggregate orderBy is not an object", groupBy({ by: ["name"], orderBy: { _count: 5 } }), "orderBy._count", /Expected an object of fields/],

    // --- aggregate --------------------------------------------------------
    [
      "count's select is not an object",
      () => compileAggregate(userWithProfile, "count" as never, { select: 5 } as never, sqlite),
      "select",
      /Expected an object of fields/,
    ],
    [
      "aggregate args are not an object",
      () => compileAggregate(userWithProfile, "aggregate" as never, 5 as never, sqlite),
      "5",
      /Expected an object/,
    ],

    // --- top-level args ---------------------------------------------------
    ["read args are not an object", read(5), "5", /Expected an object/],
    ["include is not an object", read({ include: 5 }), "include", /Expected an object/],
    ["write args are missing", write(undefined), "args", /update requires arguments/],
    ["write args are not an object", write(5), "5", /Expected an object/],

    // --- write data -------------------------------------------------------
    ["a createMany row is not an object", write({ data: [5] }, "createMany"), "data[0]", /Expected an object/],
    ["update data is not an object", write({ where: { id: 1 }, data: 5 }), "data", /Expected an object/],
    ["create data is not an object", write({ data: 5 }, "create"), "data", /Expected an object/],
    [
      "an arithmetic update names two operations",
      write({ where: { id: 1 }, data: { globalRole: { increment: 1, set: 2 } } }),
      "data.globalRole",
      /Expected exactly one of/,
    ],

    // --- nested writes ----------------------------------------------------
    ["a relation operand is not an object", write({ where: { id: 1 }, data: { accounts: 5 } }), "data.accounts", /Expected an object holding 'connect' or 'create'/],
    ["an unknown operand on an ordinary relation", write({ where: { id: 1 }, data: { accounts: { nope: 1 } } }), "data.accounts.nope", /are implemented/],
    [
      "an unknown operand through a join table",
      () => compileWrite(post, "update" as never, { where: { id: 1 }, data: { tags: { nope: 1 } } } as never, sqlite),
      "data.tags.nope",
      /implicit many-to-many/,
    ],
    ["connect on a to-one is not an object", write({ where: { id: 1 }, data: { organization: { connect: 5 } } }), "data.organization.connect", /Expected an object naming a unique field/],
    ["upsert's operand is not an object", write({ where: { id: 1 }, data: { accounts: { upsert: 5 } } }), "data.accounts.upsert", /Expected an object with 'where', 'create' and 'update'/],
    ["updateMany's operand is not an object", write({ where: { id: 1 }, data: { accounts: { updateMany: 5 } } }), "data.accounts.updateMany", /Expected an object with 'where' and 'data'/],
    ["update's operand is not an object", write({ where: { id: 1 }, data: { accounts: { update: 5 } } }), "data.accounts.update", /Expected an object with 'where' and 'data'/],
    ["disconnect's operand is not an object", write({ where: { id: 1 }, data: { accounts: { disconnect: 5 } } }), "data.accounts.disconnect", /Expected an object naming a unique field, or an array of them/],
    ["connectOrCreate's operand is not an object", write({ where: { id: 1 }, data: { accounts: { connectOrCreate: 5 } } }), "data.accounts.connectOrCreate", /Expected an object with 'where' and 'create'/],
    // --- the to-one operands, whose grammar is Prisma's other one ----------
    // `assertToOneFilter` is the guard `assertNamedRows` cannot be on this
    // path: the operand is a filter, so there is no unique key to match. Born
    // reachable, which is what this file exists to make true — the 36 sites
    // #114 found were all reachable-in-principle and unreached in fact.
    [
      "a to-one delete is neither a boolean nor a filter",
      write({ where: { id: 1 }, data: { profile: { delete: 5 } } }),
      "data.profile.delete",
      /takes either a boolean/,
    ],
    // `null` specifically, and on both sides, because it is the wrong value
    // that a *translation* used to swallow: `toOneOperand` maps `false` onto
    // `null`, so a check downstream of it could not tell the deliberate no-op
    // from an operand Prisma has no arm for. Measured on 6.19.2 —
    // `disconnect: null` is a PrismaClientValidationError there — so refusing
    // it is matching the client rather than out-stricting it.
    // `delete` rather than `disconnect` on this side, and not by preference:
    // the shared fixture's `Profile.userId` is required, so `disconnect` is
    // refused one guard earlier — on the *key* — and would pin that message
    // instead of this one. `write.test.ts` has the nullable-key fixture and
    // covers `disconnect: null` there.
    [
      "a to-one delete is null",
      write({ where: { id: 1 }, data: { profile: { delete: null } } }),
      "data.profile.delete",
      /'null' is not one of them/,
    ],
    [
      "a to-one disconnect this row owns is null",
      write({ where: { id: 1 }, data: { organization: { disconnect: null } } }),
      "data.organization.disconnect",
      /'null' is not one of them/,
    ],
    [
      "an array on a to-one whose child holds the key",
      write({ where: { id: 1 }, data: { profile: { create: [{ bio: "a" }] } } }),
      "data.profile.create",
      /Expected a single object/,
    ],
    // The owning side reads the same grammar since #359, through the same
    // guard — so a bad `disconnect` operand is refused in the same words
    // wherever the key lives. Pinned on this side too because "the same words"
    // is the property that was missing: it used to answer with a gap
    // ("only 'disconnect: true' is implemented") where the far side answered
    // with a shape.
    [
      "a to-one disconnect this row owns is neither a boolean nor a filter",
      write({ where: { id: 1 }, data: { organization: { disconnect: 5 } } }),
      "data.organization.disconnect",
      /takes either a boolean/,
    ],
    // The owning side's half of the same refusal, pinned because the message
    // now names *which* side holds the key and the two arms can only be told
    // apart by reading both.
    [
      "an array of connectOrCreate on a to-one this row owns",
      write({ where: { id: 1 }, data: { organization: { connectOrCreate: [{ where: { id: 1 }, create: {} }] } } }),
      "data.organization.connectOrCreate",
      /this row holds the foreign key/,
    ],
    // ...and `upsert` reads the same two guards from both ends since #391 —
    // `assertToOneWriteOperand` for the shape and `assertUpsertOperand` for the
    // grammar. Pinned on the owning side because it is the side that used to
    // refuse the operand outright: a missing payload was reported as an
    // unimplemented operand rather than as the incomplete one it is.
    [
      "an upsert this row owns is missing a payload",
      write({ where: { id: 1 }, data: { organization: { upsert: { create: { name: "n" } } } } }),
      "data.organization.upsert",
      /Expected a 'update' key/,
    ],
    [
      "an upsert this row owns names an unknown key",
      write({ where: { id: 1 }, data: { organization: { upsert: { wehre: {}, create: {}, update: {} } } } }),
      "data.organization.upsert",
      /Unknown key 'wehre'/,
    ],
    [
      "an array of upsert on a to-one this row owns",
      write({ where: { id: 1 }, data: { organization: { upsert: [{ create: {}, update: {} }] } } }),
      "data.organization.upsert",
      /takes \{ create, update \}/,
    ],

    // --- the operation itself ---------------------------------------------
    // Both `default:` arms after an exhaustive-looking partition. Reachable,
    // because the operation is a string from the caller rather than a union at
    // runtime — worth pinning for exactly that reason.
    ["compile is given an unknown operation", () => compile(userWithProfile, "nonsense" as never, {}, sqlite), "nonsense", /./],
    ["compileWrite is given an unknown operation", () => compileWrite(userWithProfile, "nonsense" as never, {} as never, sqlite), "nonsense", /./],
  ];

  test.each(CASES)("%s", (_label, run, argument, detail) => {
    const error = refusal(run);

    expect(error).toBeInstanceOf(UnsupportedQueryError);
    expect(error!.argument).toBe(argument);
    expect(error!.message).toMatch(detail);
  });

  /**
   * **The 36th, which nothing reaches.**
   *
   * `parseOrderBy` refuses a relation key when it is called without an
   * `OrderContext`. Four of its five callers pass one; the fifth is
   * `lateral.ts:375`, and the lateral strategy **declines** a node whose
   * `orderBy` names a relation before folding it — so that call is only ever
   * reached with an `orderBy` the strategy already accepted.
   *
   * Measured rather than assumed, and the two cases below are the measurement:
   * the same query emits no `lateral` when the ordering names a relation, and
   * does when it names a column.
   *
   * Like `select.ts:28` (#115), this is a floor rather than dead code — it is
   * what a future context-free caller would land on. What it lacked was
   * anything recording the difference, so the direct call is the honest way to
   * reach it.
   */
  describe("ordering a relation without a context", () => {
    test("parseOrderBy refuses it when called directly", () => {
      expect(() =>
        parseOrderBy(account, { user: { name: "asc" } }, "findMany"),
      ).toThrow(/Ordering by a relation is not implemented here/);
    });

    test("lateral declines such a node rather than reaching that guard", () => {
      const plan = compileRead(
        userWithProfile,
        "findMany",
        { include: { accounts: { orderBy: { user: { name: "asc" } } } } } as never,
        postgres,
        lateralStrategy,
      );
      expect(plan.text).not.toMatch(/lateral/i);
    });

    test("...and folds one whose ordering names a column", () => {
      const plan = compileRead(
        userWithProfile,
        "findMany",
        { include: { accounts: { orderBy: { id: "asc" } } } } as never,
        postgres,
        lateralStrategy,
      );
      expect(plan.text).toMatch(/lateral/i);
    });
  });
});
