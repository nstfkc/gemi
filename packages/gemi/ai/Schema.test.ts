import { describe, expect, test } from "vitest";

import { s, supportsStrict, type JSONSchema } from "./Schema";

/**
 * The invariants OpenAI's strict structured output actually enforces, checked
 * over a whole tree rather than at the root.
 *
 * This exists so that a builder added later cannot quietly break strict mode.
 * A new node type that forgets `additionalProperties`, or lists only some of
 * its properties in `required`, produces a schema the API rejects at request
 * time with a message about a path — which is a long way from the line of code
 * that emitted it. Feed anything this module can build through here and the
 * failure lands next to the builder instead.
 */
function assertStrict(schema: JSONSchema, path = "$"): void {
  const banned = ["oneOf", "allOf", "not", "pattern", "patternProperties", "$ref", "format"];
  for (const keyword of banned) {
    expect(schema, `${path} must not use ${keyword}`).not.toHaveProperty(keyword);
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("object")) {
    expect(schema.additionalProperties, `${path} must be sealed`).toBe(false);
    const properties = schema.properties ?? {};
    expect([...(schema.required ?? [])].sort(), `${path} must require every property`).toEqual(
      Object.keys(properties).sort(),
    );
    for (const [key, child] of Object.entries(properties)) {
      assertStrict(child, `${path}.${key}`);
    }
  }
  if (schema.items) assertStrict(schema.items, `${path}[]`);
  for (const [index, member] of (schema.anyOf ?? []).entries()) {
    assertStrict(member, `${path}|${index}`);
  }
}

describe("scalars", () => {
  test("emit the plain JSON Schema type and parse it back", () => {
    expect(s.string().toJSONSchema()).toEqual({ type: "string" });
    expect(s.number().toJSONSchema()).toEqual({ type: "number" });
    expect(s.boolean().toJSONSchema()).toEqual({ type: "boolean" });

    expect(s.string().parse("hi")).toBe("hi");
    expect(s.number().parse(3)).toBe(3);
    expect(s.boolean().parse(false)).toBe(false);
  });

  test("reject the wrong type by name", () => {
    expect(() => s.number().parse("3")).toThrow("expected number, got string");
    expect(() => s.string().parse(null)).toThrow("expected string, got null");
    expect(() => s.string().parse(undefined)).toThrow("expected string, got undefined");
    expect(() => s.boolean().parse(["x"])).toThrow("expected boolean, got array");
  });

  test("reject numbers JSON cannot carry back", () => {
    // A tool returning NaN produces a body that cannot be serialised for the
    // provider, so it fails here rather than three layers down.
    expect(() => s.number().parse(NaN)).toThrow("expected number, got NaN");
    expect(() => s.number().parse(Infinity)).toThrow("expected number, got Infinity");
  });
});

describe("literal() and enum()", () => {
  test("emit const and enum", () => {
    expect(s.literal("refund").toJSONSchema()).toEqual({ type: "string", const: "refund" });
    expect(s.literal(7).toJSONSchema()).toEqual({ type: "number", const: 7 });
    expect(s.literal(true).toJSONSchema()).toEqual({ type: "boolean", const: true });
    expect(s.enum(["low", "high"]).toJSONSchema()).toEqual({
      type: "string",
      enum: ["low", "high"],
    });
  });

  test("report the value they saw, not its type", () => {
    // "expected \"refund\", got string" would be true and useless.
    expect(() => s.literal("refund").parse("charge")).toThrow('expected "refund", got "charge"');
    expect(() => s.enum(["low", "high"]).parse("medium")).toThrow(
      'expected one of "low" | "high", got "medium"',
    );
  });
});

describe("object()", () => {
  const tool = s.object({
    command: s.string().describe("The shell command"),
    cwd: s.string().optional(),
  });

  test("seals itself and requires every property, optional ones included", () => {
    expect(tool.toJSONSchema()).toEqual({
      type: "object",
      properties: {
        command: { description: "The shell command", type: "string" },
        cwd: { type: ["string", "null"] },
      },
      required: ["command", "cwd"],
      additionalProperties: false,
    });
  });

  test("drops keys it does not declare", () => {
    // Decided in Schema.ts: unknown keys are dropped rather than rejected, so a
    // model slip does not cost a turn and `execute` never sees a field its
    // input type denies exists.
    expect(tool.parse({ command: "ls", cwd: "/tmp", shell: "zsh" })).toEqual({
      command: "ls",
      cwd: "/tmp",
    });
  });

  test("rejects a non-object", () => {
    expect(() => tool.parse([])).toThrow("expected object, got array");
    expect(() => tool.parse("ls")).toThrow("expected object, got string");
  });
});

describe("optional()", () => {
  const tool = s.object({ command: s.string(), cwd: s.string().optional() });

  test("stays in required, because strict mode has no optional keys", () => {
    expect(tool.toJSONSchema().required).toEqual(["command", "cwd"]);
  });

  test("tells the model to send null instead of omitting the key", () => {
    expect(tool.toJSONSchema().properties?.cwd).toEqual({ type: ["string", "null"] });
  });

  test("round trips: null in, key absent out", () => {
    const parsed = tool.parse({ command: "ls", cwd: null });
    expect(parsed).toEqual({ command: "ls" });
    expect("cwd" in parsed).toBe(false);
  });

  test("treats an omitted key the same way, rather than failing", () => {
    expect(tool.parse({ command: "ls" })).toEqual({ command: "ls" });
  });

  test("still checks the value when one is actually sent", () => {
    expect(() => tool.parse({ command: "ls", cwd: 7 })).toThrow(
      "cwd: expected string or null, got number",
    );
  });
});

describe("nullable()", () => {
  const note = s.object({ note: s.string().nullable() });

  test("keeps null as a value rather than as an absence", () => {
    const parsed = note.parse({ note: null });
    expect(parsed).toEqual({ note: null });
    expect("note" in parsed).toBe(true);
  });

  test("composes with optional() without collapsing into it", () => {
    // `.nullable().optional()` is optional: null means the key goes away.
    const optionalLast = s.object({ x: s.string().nullable().optional() });
    expect(optionalLast.parse({ x: null })).toEqual({});

    // `.optional().nullable()` is not: `nullable()` returns a plain
    // SchemaBuilder, so the key is required again in the TypeScript type and
    // the parse has to keep it.
    const nullableLast = s.object({ x: s.string().optional().nullable() });
    expect(nullableLast.parse({ x: null })).toEqual({ x: null });

    // Same wire schema either way — the model has one spelling for "nothing".
    expect(optionalLast.toJSONSchema()).toEqual(nullableLast.toJSONSchema());
  });

  test("wraps rather than widens where null cannot join the type", () => {
    expect(s.enum(["a", "b"]).nullable().toJSONSchema()).toEqual({
      anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }],
    });
    expect(s.literal("a").nullable().toJSONSchema()).toEqual({
      anyOf: [{ type: "string", const: "a" }, { type: "null" }],
    });
  });
});

describe("array()", () => {
  test("emits items and parses element by element", () => {
    const ids = s.array(s.string());
    expect(ids.toJSONSchema()).toEqual({ type: "array", items: { type: "string" } });
    expect(ids.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => ids.parse("a")).toThrow("expected array, got string");
  });
});

describe("union()", () => {
  const result = s.union([
    s.object({ status: s.literal("ok"), total: s.number() }),
    s.object({ status: s.literal("failed"), reason: s.string() }),
  ]);

  test("emits anyOf", () => {
    expect(result.toJSONSchema().anyOf).toHaveLength(2);
    expect(result.toJSONSchema()).not.toHaveProperty("oneOf");
  });

  test("parses whichever member matches", () => {
    expect(result.parse({ status: "ok", total: 12 })).toEqual({ status: "ok", total: 12 });
    expect(result.parse({ status: "failed", reason: "card" })).toEqual({
      status: "failed",
      reason: "card",
    });
  });

  test("blames the variant that matched furthest, not 'no match'", () => {
    // The discriminator picked the variant; only `total` is wrong, and that is
    // the one fact worth reporting.
    expect(result.safeParse({ status: "ok", total: "12" })).toEqual({
      ok: false,
      errors: ["no matching variant; closest: total: expected number, got string"],
    });
  });

  test("keeps the path when the union is nested", () => {
    const wrapped = s.object({ results: s.array(result) });
    expect(() => wrapped.parse({ results: [{ status: "ok", total: "12" }] })).toThrow(
      "results[0]: no matching variant; closest: results[0].total: expected number, got string",
    );
  });
});

describe("error reporting", () => {
  const orders = s.object({
    orders: s.array(s.object({ total: s.number(), note: s.string().optional() })),
  });

  test("parse() throws a path-qualified message", () => {
    expect(() => orders.parse({ orders: [{ total: 1 }, { total: 2 }, { total: "3" }] })).toThrow(
      "orders[2].total: expected number, got string",
    );
  });

  test("safeParse() returns the same information and never throws", () => {
    expect(orders.safeParse({ orders: [{ total: "3", note: 4 }] })).toEqual({
      ok: false,
      errors: [
        "orders[0].total: expected number, got string",
        "orders[0].note: expected string or null, got number",
      ],
    });
  });

  test("safeParse() hands back the parsed value on success", () => {
    const parsed = orders.safeParse({ orders: [{ total: 3, note: null }] });
    expect(parsed).toEqual({ ok: true, value: { orders: [{ total: 3 }] } });
  });
});

describe("builders are immutable", () => {
  test("describe() does not leak into the schema it was called on", () => {
    // The bug every fluent builder has once: `describe` mutating in place, so a
    // shared `const` picks up a description meant for one of its two uses and
    // the model is told the wrong thing somewhere else entirely.
    const id = s.string();
    const customerId = id.describe("The customer's id");

    expect(id.toJSONSchema()).toEqual({ type: "string" });
    expect(customerId.toJSONSchema()).toEqual({
      type: "string",
      description: "The customer's id",
    });

    const shape = s.object({ id, customerId });
    expect(shape.toJSONSchema().properties).toEqual({
      id: { type: "string" },
      customerId: { type: "string", description: "The customer's id" },
    });
  });

  test("optional() and nullable() do not leak either", () => {
    const id = s.string();
    id.optional();
    id.nullable();
    expect(id.toJSONSchema()).toEqual({ type: "string" });

    const shape = s.object({ required: id, loose: id.optional() });
    expect(shape.toJSONSchema().properties).toEqual({
      required: { type: "string" },
      loose: { type: ["string", "null"] },
    });
    expect(() => shape.parse({ required: null, loose: null })).toThrow(
      "required: expected string, got null",
    );
  });

  test("describe() twice keeps the first schema intact", () => {
    const base = s.number();
    const cents = base.describe("in cents");
    const dollars = base.describe("in dollars");
    expect(cents.toJSONSchema().description).toBe("in cents");
    expect(dollars.toJSONSchema().description).toBe("in dollars");
    expect(base.toJSONSchema().description).toBeUndefined();
  });
});

describe("strict-mode invariants", () => {
  const deep = s.object({
    customerId: s.string().describe("Who the order belongs to"),
    priority: s.enum(["low", "high"]).optional(),
    orders: s.array(
      s.object({
        id: s.string(),
        total: s.number(),
        note: s.string().nullable(),
        lines: s.array(
          s.object({
            sku: s.string(),
            quantity: s.number(),
            gift: s.boolean().optional(),
          }),
        ),
        outcome: s.union([
          s.object({ status: s.literal("shipped"), trackingId: s.string() }),
          s.object({
            status: s.literal("refunded"),
            reason: s.enum(["damaged", "late"]),
            refund: s.object({ amount: s.number(), currency: s.literal("usd") }),
          }),
        ]),
      }),
    ),
  });

  test("hold everywhere in a deeply nested schema", () => {
    assertStrict(deep.toJSONSchema());
  });

  test("hold for every builder on its own", () => {
    const every = [
      s.string(),
      s.number(),
      s.boolean(),
      s.literal("x"),
      s.enum(["x", "y"]),
      s.object({}),
      s.array(s.string()),
      s.union([s.object({ a: s.string() }), s.object({ b: s.number() })]),
    ];
    for (const schema of every) {
      assertStrict(schema.toJSONSchema());
      assertStrict(schema.optional().toJSONSchema());
      assertStrict(schema.nullable().toJSONSchema());
      assertStrict(s.object({ field: schema.optional() }).toJSONSchema());
      assertStrict(s.array(schema).toJSONSchema());
    }
  });

  test("the walker actually fails on a schema that breaks them", () => {
    // Otherwise the test above passes for a schema that emits nothing at all.
    expect(() =>
      assertStrict({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      }),
    ).toThrow();
    expect(() =>
      assertStrict({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }),
    ).toThrow();
  });

  test("a deeply nested value round trips through parse", () => {
    const value = {
      customerId: "cus_1",
      priority: null,
      orders: [
        {
          id: "ord_1",
          total: 42,
          note: null,
          lines: [{ sku: "A", quantity: 2, gift: null }],
          outcome: { status: "shipped", trackingId: "tr_1" },
        },
      ],
    };
    expect(deep.parse(value)).toEqual({
      customerId: "cus_1",
      orders: [
        {
          id: "ord_1",
          total: 42,
          note: null,
          lines: [{ sku: "A", quantity: 2 }],
          outcome: { status: "shipped", trackingId: "tr_1" },
        },
      ],
    });
  });
});

describe("json()", () => {
  test("emits the empty schema, which constrains nothing", () => {
    expect(s.json().toJSONSchema()).toEqual({});
  });

  test("carries a description, the only thing the model is told about it", () => {
    expect(s.json().describe("A kyte ApplicationDefinition").toJSONSchema()).toEqual({
      description: "A kyte ApplicationDefinition",
    });
  });

  test("does not grow an anyOf when made optional or nullable", () => {
    // `{}` already admits null. Widening it would emit `anyOf: [{}, null]`,
    // whose second branch is a narrower repeat of its first.
    expect(s.json().optional().toJSONSchema()).toEqual({});
    expect(s.json().nullable().toJSONSchema()).toEqual({});
  });

  test.each([
    ["an object with arbitrary keys", { a: 1, b: { c: [true, null] } }],
    ["a mixed-type tuple", ["div", { id: "x" }, ["hello"]]],
    ["a bare scalar", "text"],
    ["a number", 0],
    ["false", false],
    ["null", null],
    ["a deeply recursive document", { t: "a", c: [{ t: "b", c: [{ t: "c", c: [] }] }] }],
  ])("passes %s straight through", (_what, value) => {
    expect(s.json().parse(value)).toEqual(value);
  });

  test("hands back the very same object, not a copy", () => {
    // The agent loop signs the parsed input and later verifies the signature
    // against it. A rebuild would also have to be exactly faithful; identity
    // cannot be anything else.
    const value = { state: {}, root: ["div", {}, []] };
    expect(s.json().parse(value)).toBe(value);
  });

  test("keeps a key whose value is an empty object, which a rebuild would drop", () => {
    const value = { state: { count: 0 }, empty: {} };
    expect(s.json().parse(value)).toEqual(value);
  });

  describe("rejects what JSON cannot carry", () => {
    test.each([
      ["a function", () => {}, "a function"],
      ["a bigint", 1n, "a bigint"],
      ["a symbol", Symbol("x"), "a symbol"],
      ["NaN", NaN, "NaN"],
      ["Infinity", Infinity, "Infinity"],
    ])("%s", (_what, value, reported) => {
      expect(s.json().safeParse(value)).toEqual({
        ok: false,
        errors: [`expected a JSON value, got ${reported}`],
      });
    });

    test("naming where it found it", () => {
      const result = s.json().safeParse({ root: ["div", { onClick: () => {} }] });
      expect(result).toEqual({
        ok: false,
        errors: ["root[1].onClick: expected a JSON value, got a function"],
      });
    });

    test("a cycle, rather than walking it forever", () => {
      const value: any = { name: "root" };
      value.self = value;
      expect(s.json().safeParse(value)).toEqual({
        ok: false,
        errors: ["self: expected a JSON value, got a circular reference"],
      });
    });

    test("but not the same object twice side by side, which is not a cycle", () => {
      // The walk has to un-mark a node on the way out. Left marked, this is
      // reported as a cycle — and `JSON.stringify` writes it out quite happily.
      const shared = { shared: true };
      expect(s.json().safeParse({ a: shared, b: shared })).toEqual({
        ok: true,
        value: { a: shared, b: shared },
      });
    });

    test("undefined, where the field is not optional", () => {
      expect(s.object({ doc: s.json() }).safeParse({})).toEqual({
        ok: false,
        errors: ["doc: expected a JSON value, got undefined"],
      });
    });

    test("but drops the key instead when it is", () => {
      expect(s.object({ doc: s.json().optional() }).parse({})).toEqual({});
      expect(s.object({ doc: s.json().optional() }).parse({ doc: null })).toEqual({});
    });
  });

  test("allows undefined below the root, where JSON.stringify has its own answer", () => {
    // A dropped property and a `null` element are what `JSON.stringify` does
    // with these. Refusing them here would mean refusing an object built by
    // spreading optional fields.
    const value = { a: undefined, b: [undefined] };
    expect(s.json().safeParse(value)).toEqual({ ok: true, value });
  });

  test("allows a value with a toJSON, rather than refusing a Date to catch a Map", () => {
    const value = { at: new Date("2026-01-01T00:00:00.000Z") };
    expect(s.json().safeParse(value)).toEqual({ ok: true, value });
  });

  test("composes as an ordinary field, and the object around it stays sealed", () => {
    const schema = s.object({
      name: s.string(),
      definition: s.json().describe("The UI document"),
    });
    expect(schema.toJSONSchema()).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        definition: { description: "The UI document" },
      },
      required: ["name", "definition"],
      additionalProperties: false,
    });
  });

  test("is still subject to the surrounding object dropping undeclared keys", () => {
    const schema = s.object({ definition: s.json() });
    expect(schema.parse({ definition: { a: 1 }, stray: 2 })).toEqual({ definition: { a: 1 } });
  });

  test("matches in a union without the other members getting a say", () => {
    const schema = s.union([s.object({ kind: s.literal("ref"), id: s.string() }), s.json()]);
    expect(schema.parse({ kind: "ref", id: "r1" })).toEqual({ kind: "ref", id: "r1" });
    // The literal member fails, the json member cannot — so no "no matching
    // variant", which is the whole reason to reach for this in a union.
    expect(schema.parse({ anything: [1, 2] })).toEqual({ anything: [1, 2] });
  });
});

describe("supportsStrict", () => {
  test("is true for every schema built out of the strict subset", () => {
    for (const schema of [
      s.string(),
      s.number().optional(),
      s.boolean().nullable(),
      s.literal("x"),
      s.enum(["x", "y"]),
      s.object({}),
      s.object({ a: s.array(s.object({ b: s.string() })) }),
      s.union([s.object({ a: s.string() }), s.object({ b: s.number() })]),
    ]) {
      expect(supportsStrict(schema), JSON.stringify(schema.toJSONSchema())).toBe(true);
    }
  });

  test("is false for a json node, wherever it is buried", () => {
    for (const schema of [
      s.json(),
      s.json().optional(),
      s.object({ doc: s.json() }),
      s.array(s.json()),
      s.array(s.object({ doc: s.json().describe("x") })),
      s.object({ a: s.object({ b: s.array(s.object({ c: s.json() })) }) }),
      s.union([s.object({ a: s.string() }), s.object({ b: s.json() })]),
      s.union([s.object({ a: s.string() }), s.json()]),
    ]) {
      expect(supportsStrict(schema), JSON.stringify(schema.toJSONSchema())).toBe(false);
    }
  });

  test("answers true for a hand-built schema, which has no tree to walk", () => {
    // `questionSchema` in `ai/Agent.ts` and the merged one in `services/mcp`
    // are cast into `Schema<T>` rather than built with `s`. Throwing here would
    // have broken `Agent.ask` at construction.
    const foreign = {
      toJSONSchema: () => ({ type: "object" as const }),
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ ok: true as const, value: v }),
    } as never;
    expect(supportsStrict(foreign)).toBe(true);
  });
});

describe("foreign schemas", () => {
  test("are refused where a builder is expected", () => {
    // `Schema<T>` is three methods; anything can claim to be one. Catching it
    // at construction beats a `toJSONSchema()` that returns undefined.
    const fake = { toJSONSchema: () => ({}), parse: (v: unknown) => v, safeParse: () => null };
    expect(() => s.object({ fake } as never)).toThrow("foreign object");
  });
});
