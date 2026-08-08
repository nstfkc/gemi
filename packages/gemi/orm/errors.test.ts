import { describe, expect, test } from "vitest";

import {
  RecordNotFoundError,
  UniqueConstraintError,
  isUniqueConstraintError,
} from "./errors";

/**
 * `isUniqueConstraintError`, and specifically the half of it that is not
 * `instanceof`.
 *
 * The predicate exists because a retry-on-collision `catch` written against
 * `instanceof` is silently dead across a duplicate copy of `gemi/orm` — two
 * versions in one dependency tree, a bundled build beside a linked one. That is
 * the same failure mode #357 measured with `code === "P2002"`: the `catch` runs,
 * the condition is false, the recovery does not happen, and nothing is logged.
 *
 * So the interesting test is not that a real error matches. It is that an error
 * from a *second class of the same name* matches, and that the surrounding
 * near-misses do not.
 */
describe("isUniqueConstraintError", () => {
  const real = new UniqueConstraintError("User", "create", ["email"], "User_email_key");

  test("matches the error the ORM throws", () => {
    expect(isUniqueConstraintError(real)).toBe(true);
  });

  /**
   * The duplicate-copy case, built the way it actually occurs: a second
   * evaluation of the same module gives a *different class object* with the
   * same behaviour. `instanceof` against this file's class is false for it, and
   * that is exactly what the name branch is for.
   */
  test("matches an instance from a duplicate copy of the module", () => {
    class UniqueConstraintError extends Error {
      constructor(
        public readonly model: string,
        public readonly operation: string,
        public readonly fields: string[],
      ) {
        super("Unique constraint violated");
        this.name = "UniqueConstraintError";
      }
    }
    const duplicate = new UniqueConstraintError("User", "create", ["email"]);

    // The premise: this is the case a hand-written `instanceof` gets wrong.
    expect(duplicate instanceof real.constructor).toBe(false);
    expect(isUniqueConstraintError(duplicate)).toBe(true);
  });

  /**
   * `P2002` is deliberately not matched. Keeping a Prisma code out of gemi's
   * permanent surface is what the DECISION note in `errors.ts` decided, and the
   * bridge for a half-ported codebase lives in `UPGRADE.md` where it can carry
   * a delete-me marker. Pinned here so that "it would be so convenient" cannot
   * quietly add it later.
   */
  test("does not match a Prisma P2002", () => {
    const prisma = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["email"] },
    });

    expect(isUniqueConstraintError(prisma)).toBe(false);
  });

  test.each([
    ["another gemi error", new RecordNotFoundError("User", "findUniqueOrThrow")],
    ["a plain Error", new Error("Unique constraint violated on User.create")],
    ["a string that says so", "UniqueConstraintError"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an empty object", {}],
    ["an object with the wrong name", { name: "UnknownFieldError" }],
    ["an object with no name at all", { model: "User", fields: ["email"] }],
  ])("does not match %s", (_label, value) => {
    expect(isUniqueConstraintError(value)).toBe(false);
  });

  /** The narrowing is the reason this is a predicate rather than a boolean. */
  test("narrows to the error's own fields", () => {
    const error: unknown = real;

    if (!isUniqueConstraintError(error)) throw new Error("unreachable");

    expect(error.model).toBe("User");
    expect(error.operation).toBe("create");
    expect(error.fields).toEqual(["email"]);
    expect(error.constraint).toBe("User_email_key");
  });

  /**
   * The name branch only works because every error in this file sets
   * `this.name` in its constructor rather than relying on the class name. A
   * subclass that forgot to would be invisible to the predicate, so the
   * property the predicate reads is asserted rather than assumed.
   */
  test("the class sets the name the predicate reads", () => {
    expect(real.name).toBe("UniqueConstraintError");
  });

  test("gemi/orm exports it", async () => {
    const orm = await import("./index");
    expect(orm.isUniqueConstraintError).toBe(isUniqueConstraintError);
  });
});
