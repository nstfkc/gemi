import { describe, expectTypeOf, test } from "vitest";

import { UserModel } from "./generated";

/**
 * #664 at the type level: `skipIfUnchanged` on `update` / `updateMany` only,
 * and the JSON key filters on a `Json` column only, with the operand types the
 * compiler checks.
 */
describe("skipIfUnchanged", () => {
  test("update keeps its result type", async () => {
    expectTypeOf(
      await UserModel.update({
        where: { id: 1 },
        data: { name: "n" },
        select: { id: true },
        skipIfUnchanged: true,
      }),
    ).toEqualTypeOf<{ id: number }>();

    expectTypeOf(
      await UserModel.updateMany({ data: { name: "n" }, skipIfUnchanged: true }),
    ).toEqualTypeOf<{ count: number }>();
  });

  test("is not an upsert or create argument", () => {
    UserModel.upsert({
      where: { id: 1 },
      create: {},
      update: {},
      // @ts-expect-error — upsert has no skipIfUnchanged
      skipIfUnchanged: true,
    });

    // @ts-expect-error — create has no skipIfUnchanged
    UserModel.create({ data: {}, skipIfUnchanged: true });
  });

  test("takes a boolean", () => {
    // @ts-expect-error — not a boolean
    UserModel.update({ where: { id: 1 }, data: {}, skipIfUnchanged: "yes" });
  });
});

describe("JSON key filters", () => {
  test("on the column and at a path", () => {
    UserModel.findMany({ where: { metadata: { has_key: "plan" } } });
    UserModel.findMany({ where: { metadata: { has_some_keys: ["a", "b"] } } });
    UserModel.findMany({ where: { metadata: { has_every_key: ["a"] } } });
    UserModel.findMany({ where: { metadata: { path: ["billing"], has_key: "card" } } });
    UserModel.findMany({ where: { metadata: { not: { has_key: "plan" } } } });
  });

  test("operand types", () => {
    // @ts-expect-error — has_key takes one key
    UserModel.findMany({ where: { metadata: { has_key: ["a"] } } });
    // @ts-expect-error — the list forms take an array
    UserModel.findMany({ where: { metadata: { has_some_keys: "a" } } });
  });

  test("only on a Json column", () => {
    // @ts-expect-error — name is a String
    UserModel.findMany({ where: { name: { has_key: "a" } } });
  });
});
