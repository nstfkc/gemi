import { beforeEach, describe, expect, test } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { account, organization, user } from "../fixtures";
import * as registry from "../registry";
import { compileRead } from "./read";
import { resolveSelection } from "./select";
import { compileWrite } from "./write";

const sqlite = new SqliteDialect();

/**
 * `select.ts`'s refusals — every one of which was unreached by any test in the
 * repo, unit or template (#114).
 *
 * Found by instrumenting `UnsupportedQueryError`'s constructor to record its
 * call site and diffing that against every construction site in `orm/`: 143
 * sites, 98 reached, 45 not. All eight of this file's were in the 45.
 *
 * Seven turned out reachable and correct, which is worth stating plainly —
 * unreached is not the same as wrong. The eighth is the interesting one, and
 * it has its own case at the bottom.
 */
describe("resolveSelection refuses", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Account", class { static $schema = account });
    registry.register("Organization", class { static $schema = organization });
  });

  const read = (args: unknown) => {
    try {
      compileRead(user, "findMany", args as never, sqlite);
      return null;
    } catch (error) {
      return error as UnsupportedQueryError;
    }
  };

  const every = Object.fromEntries(
    Object.keys(user.fields).map((name) => [name, true]),
  );

  test.each([
    [
      "select with omit",
      { select: { id: true }, omit: { name: true } },
      "select + omit",
      /describe different column lists/,
    ],
    ["select is an array", { select: [1] }, "select", /Expected an object/],
    [
      "a selected field is not a boolean",
      { select: { id: 1 } },
      "select.id",
      /Expected true or false/,
    ],
    ["omit is an array", { omit: [1] }, "omit", /Expected an object of fields/],
    [
      "omit names a relation",
      { omit: { accounts: true } },
      "omit.accounts",
      /is a relation, not a column/,
    ],
    [
      "an omitted field is not a boolean",
      { omit: { name: 1 } },
      "omit.name",
      /Expected true or false/,
    ],
  ])("%s", (_label, args, argument, detail) => {
    const error = read(args);

    expect(error).toBeInstanceOf(UnsupportedQueryError);
    expect(error!.argument).toBe(argument);
    expect(error!.model).toBe("User");
    expect(error!.operation).toBe("findMany");
    expect(error!.message).toMatch(detail);
  });

  /**
   * The eighth reachable one, kept separate because it is built from the
   * schema rather than written out: omitting every column leaves no column
   * list, which is not a query.
   */
  test("omit that names every field", () => {
    const error = read({ omit: every });

    expect(error).toBeInstanceOf(UnsupportedQueryError);
    expect(error!.argument).toBe("omit");
    expect(error!.message).toMatch(/omits every field on User/);
  });

  // `resolveSelection` serves reads and writes both, and the refusals are the
  // same code — so one write case pins that the operation is reported as the
  // caller's rather than hardcoded to a read.
  test("a write reports its own operation", () => {
    let error: UnsupportedQueryError | null = null;
    try {
      compileWrite(
        user,
        "update",
        {
          where: { id: 1 },
          data: { name: "x" },
          select: { id: true },
          omit: { name: true },
        } as never,
        sqlite,
      );
    } catch (raised) {
      error = raised as UnsupportedQueryError;
    }

    expect(error!.argument).toBe("select + omit");
    expect(error!.operation).toBe("update");
  });

  /**
   * **The one no caller reaches.**
   *
   * All four callers of `resolveSelection` check `select` + `include` before
   * calling it, and each says it better — `plan-relations.ts` reports
   * `'accounts: select + include'` with the relation path, which this one
   * cannot know. So the guard is the floor under a fifth caller rather than a
   * duplicate to delete.
   *
   * Called directly, because that is the honest way to reach it: going through
   * the public API would test whichever caller pre-empted it, which is what
   * the two cases below do deliberately.
   */
  describe("select with include", () => {
    test("resolveSelection refuses it when reached directly", () => {
      expect(() =>
        resolveSelection(
          user,
          { select: { id: true }, include: { accounts: true } },
          "findMany",
        ),
      ).toThrow(/only one of them on the same query/);
    });

    // ...and the two that get there first, so the pre-emption is pinned. If a
    // caller's own check is removed, these change and the one above does not.
    test("a read is refused by the read compiler, with no relation path", () => {
      const error = read({ select: { id: true }, include: { accounts: true } });
      expect(error!.argument).toBe("select + include");
    });

    test("a relation node is refused with its path", () => {
      const error = read({
        include: { accounts: { select: { id: true }, include: { user: true } } },
      });
      expect(error!.argument).toBe("accounts: select + include");
    });
  });
});
