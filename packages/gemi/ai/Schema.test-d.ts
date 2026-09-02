/**
 * Type-level tests for the schema builder.
 *
 * The builder's whole reason for existing is that one declaration produces both
 * a JSON Schema and a TypeScript type. `Schema.test.ts` covers the first half;
 * nothing at runtime can cover the second, so `Infer` is asserted here instead.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import { s, type Infer } from "./Schema";

describe("Infer over the leaves", () => {
  test("reads scalars back", () => {
    expectTypeOf<Infer<ReturnType<typeof s.string>>>().toEqualTypeOf<string>();
    expectTypeOf<Infer<ReturnType<typeof s.number>>>().toEqualTypeOf<number>();
    expectTypeOf<Infer<ReturnType<typeof s.boolean>>>().toEqualTypeOf<boolean>();
  });

  test("keeps a literal literal", () => {
    const status = s.literal("refunded");
    expectTypeOf<Infer<typeof status>>().toEqualTypeOf<"refunded">();
    expectTypeOf<Infer<typeof status>>().not.toEqualTypeOf<string>();
  });

  test("turns an enum into the union of its members", () => {
    const priority = s.enum(["low", "high"]);
    expectTypeOf<Infer<typeof priority>>().toEqualTypeOf<"low" | "high">();
  });

  test("survives describe(), which changes prose and nothing else", () => {
    const described = s.string().describe("The customer's id");
    expectTypeOf<Infer<typeof described>>().toEqualTypeOf<string>();
  });
});

describe("Infer over objects", () => {
  test("infers the object type it describes", () => {
    const schema = s.object({ command: s.string(), cwd: s.string().optional() });
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{ command: string; cwd?: string }>();
  });

  test("makes only the optional keys optional", () => {
    const schema = s.object({ a: s.string(), b: s.number().optional() });
    // `b` may be missing, `a` may not — the point of the OPTIONAL marker, and
    // the thing that breaks the moment optionality is read off `T | undefined`.
    expectTypeOf<Infer<typeof schema>>().toMatchObjectType<{ a: string }>();
    expectTypeOf<{ a: "x" }>().toExtend<Infer<typeof schema>>();
    expectTypeOf<{ b: 1 }>().not.toExtend<Infer<typeof schema>>();
  });

  test("does not make a nullable key optional", () => {
    const schema = s.object({ note: s.string().nullable() });
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{ note: string | null }>();
    // Absent is not the same as null: `nullable()` promises the key is there.
    expectTypeOf<{}>().not.toExtend<Infer<typeof schema>>();
  });

  test("nullable() after optional() takes the key back off the optional list", () => {
    const schema = s.object({ x: s.string().optional().nullable() });
    expectTypeOf<{}>().not.toExtend<Infer<typeof schema>>();
  });

  test("optional() after nullable() leaves it optional", () => {
    const schema = s.object({ x: s.string().nullable().optional() });
    expectTypeOf<{}>().toExtend<Infer<typeof schema>>();
  });

  test("drops the readonly the const shape literal would otherwise carry", () => {
    const schema = s.object({ id: s.string() });
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Infer<typeof schema>>().not.toEqualTypeOf<{ readonly id: string }>();
  });
});

describe("Infer over arrays and unions", () => {
  test("reads an array of objects", () => {
    const schema = s.array(s.object({ id: s.string(), total: s.number() }));
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{ id: string; total: number }[]>();
  });

  test("reads a union as the union of its members", () => {
    const schema = s.union([
      s.object({ status: s.literal("ok"), total: s.number() }),
      s.object({ status: s.literal("failed"), reason: s.string() }),
    ]);
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<
      { status: "ok"; total: number } | { status: "failed"; reason: string }
    >();
  });

  test("narrows a union on its discriminator", () => {
    const schema = s.union([
      s.object({ status: s.literal("ok"), total: s.number() }),
      s.object({ status: s.literal("failed"), reason: s.string() }),
    ]);
    const value = {} as Infer<typeof schema>;
    if (value.status === "ok") {
      expectTypeOf(value.total).toEqualTypeOf<number>();
    } else {
      expectTypeOf(value.reason).toEqualTypeOf<string>();
    }
  });

  test("refuses a union of one, which is just the member", () => {
    // @ts-expect-error a union needs at least two members
    s.union([s.string()]);
  });
});

describe("Infer through nesting", () => {
  const schema = s.object({
    customerId: s.string(),
    priority: s.enum(["low", "high"]).optional(),
    orders: s.array(
      s.object({
        id: s.string(),
        note: s.string().nullable(),
        outcome: s.union([
          s.object({ status: s.literal("shipped"), trackingId: s.string() }),
          s.object({ status: s.literal("refunded"), amount: s.number() }),
        ]),
      }),
    ),
  });

  test("keeps optionality, nullability and discrimination at depth", () => {
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{
      customerId: string;
      priority?: "low" | "high";
      orders: {
        id: string;
        note: string | null;
        outcome: { status: "shipped"; trackingId: string } | { status: "refunded"; amount: number };
      }[];
    }>();
  });

  test("types what parse() hands back", () => {
    expectTypeOf(schema.parse({})).toEqualTypeOf<Infer<typeof schema>>();
  });

  test("types safeParse() as a discriminated result", () => {
    // Pulled apart with `Extract` rather than `if (result.ok) … else`, and not
    // for style: this package compiles with `strict: false`, and without
    // `strictNullChecks` TypeScript narrows the `true` arm of a boolean
    // discriminant but not the `false` one. So an app that compiles strictly
    // gets the `if`, and an assertion written that way would fail here for a
    // reason that has nothing to do with the schema.
    type Result = ReturnType<typeof schema.safeParse>;
    expectTypeOf<Extract<Result, { ok: true }>["value"]>().toEqualTypeOf<Infer<typeof schema>>();
    expectTypeOf<Extract<Result, { ok: false }>["errors"]>().toEqualTypeOf<string[]>();
  });
});
