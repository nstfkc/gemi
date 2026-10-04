import { describe, expect, test } from "vitest";
import { JSONSchemaError, s, supportsStrict } from "./Schema";

/**
 * `s.fromJSONSchema` (#710), with kyte's collection item schema as the main
 * fixture: it is what this was written to replace Ajv for, so the formats,
 * `x-order`, `title`s and the per-field issues are tested the way kyte uses
 * them.
 */
const LINK = /^(https?:\/\/|mailto:|tel:|\/|#)/i;
const SITE_FILE = /^\/api\/pages\/[^/]+\/files\/[^/]+$/;
const formats = { markdown: true as const, uri: LINK, image: SITE_FILE };

const collection = {
  type: "object",
  properties: {
    title: { type: "string", title: "Title", minLength: 2, maxLength: 20 },
    body: { type: "string", title: "Body", format: "markdown", description: "The text." },
    link: { type: "string", title: "Link", format: "uri" },
    photo: { type: "string", title: "Photo", format: "image" },
    price: { type: "number", title: "Price", minimum: 0, maximum: 1000 },
    stock: { type: "integer", title: "Stock" },
    featured: { type: "boolean", title: "Featured" },
    size: { type: "string", title: "Size", enum: ["S", "M", "L"], maxLength: 500 },
  },
  required: ["title", "price"],
  additionalProperties: false,
  "x-order": ["title", "body", "link", "photo", "price", "stock", "featured", "size"],
};

describe("s.fromJSONSchema", () => {
  test("reads kyte's collection schema and stays strict-mode safe", () => {
    const schema = s.fromJSONSchema(collection, { formats });
    expect(supportsStrict(schema)).toBe(true);
    const json = schema.toJSONSchema();
    expect(json).toMatchObject({
      type: "object",
      required: Object.keys(collection.properties),
      additionalProperties: false,
    });
    // Constraints strict mode refuses as keywords are said in the description.
    expect(json.properties!.title).toEqual({
      type: "string",
      description: "At least 2 characters. At most 20 characters.",
    });
    expect(json.properties!.body).toEqual({
      type: ["string", "null"],
      description: "The text. Format: markdown.",
    });
    expect(json.properties!.price).toEqual({
      type: "number",
      description: "Minimum 0. Maximum 1000.",
    });
    expect(json.properties!.stock).toEqual({ type: ["integer", "null"] });
    expect(json.properties!.size).toMatchObject({
      anyOf: [{ type: "string", enum: ["S", "M", "L"] }, { type: "null" }],
    });
    expect(JSON.stringify(json)).not.toContain("x-order");
    expect(JSON.stringify(json)).not.toContain("Title");
  });

  test("a valid item parses, with optional fields dropped when absent or null", () => {
    const schema = s.fromJSONSchema(collection, { formats });
    const result = schema.validate({
      title: "Shirt",
      body: "# Hi",
      link: "https://example.com",
      photo: "/api/pages/p1/files/f1",
      price: 10,
      stock: null,
      size: "M",
      extra: "dropped",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Shirt",
        body: "# Hi",
        link: "https://example.com",
        photo: "/api/pages/p1/files/f1",
        price: 10,
        size: "M",
      },
    });
  });

  test("validate reports every problem, per path, with Ajv's keyword names", () => {
    const schema = s.fromJSONSchema(collection, { formats });
    const result = schema.validate({
      title: "x",
      link: "javascript:alert(1)",
      photo: "https://elsewhere.com/a.png",
      stock: 1.5,
      featured: "yes",
      size: "XL",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ path, code, params }) => ({ path, code, params }))).toEqual([
      { path: ["title"], code: "minLength", params: { limit: 2 } },
      { path: ["link"], code: "format", params: { format: "uri" } },
      { path: ["photo"], code: "format", params: { format: "image" } },
      { path: ["price"], code: "required", params: {} },
      { path: ["stock"], code: "type", params: {} },
      { path: ["featured"], code: "type", params: {} },
      { path: ["size"], code: "enum", params: { allowedValues: ["S", "M", "L"] } },
    ]);
    expect(schema.safeParse({ title: "x", price: 2000 })).toEqual({
      ok: false,
      errors: [
        "title: expected at least 2 characters, got 1",
        "price: expected at most 1000, got 2000",
      ],
    });
  });

  test("lengths count code points, as JSON Schema does", () => {
    const schema = s.fromJSONSchema({ type: "string", maxLength: 2 });
    expect(schema.validate("😀😀").ok).toBe(true);
    expect(schema.validate("😀😀😀").ok).toBe(false);
  });

  test("a format check that throws is a failed check, and a g-flag regex is reset", () => {
    const thrower = s.fromJSONSchema(
      { type: "string", format: "odd" },
      {
        formats: {
          odd: () => {
            throw new Error("boom");
          },
        },
      },
    );
    expect(thrower.validate("a")).toMatchObject({ ok: false, issues: [{ code: "format" }] });

    const global = s.fromJSONSchema({ type: "string", format: "a" }, { formats: { a: /a/g } });
    expect(global.validate("a").ok).toBe(true);
    expect(global.validate("a").ok).toBe(true);
  });

  test("nested objects, arrays, nullables, const, numeric enums and anyOf", () => {
    const schema = s.fromJSONSchema({
      type: "object",
      properties: {
        kind: { const: "order" },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        note: { type: ["string", "null"] },
        level: { enum: [1, 2, 3] },
        mode: { enum: ["a", null] },
        value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["kind", "tags", "note", "level", "mode", "value", "address"],
    });
    expect(supportsStrict(schema)).toBe(true);
    expect(
      schema.safeParse({
        kind: "order",
        tags: ["a"],
        note: null,
        level: 2,
        mode: null,
        value: 3,
        address: { city: "Berlin" },
      }),
    ).toMatchObject({ ok: true });
    const bad = schema.validate({
      kind: "other",
      tags: [],
      note: 1,
      level: 4,
      mode: "b",
      value: true,
      address: {},
    });
    expect(bad.ok === false && bad.issues.map((issue) => [issue.path, issue.code])).toEqual([
      [["kind"], "const"],
      [["tags"], "minItems"],
      [["note"], "type"],
      [["level"], "anyOf"],
      [["mode"], "enum"],
      [["value"], "anyOf"],
      [["address", "city"], "required"],
    ]);
  });

  test("description and the builder methods still work on the result", () => {
    const schema = s.object({
      item: s.fromJSONSchema({ type: "string" }).describe("An item").optional(),
    });
    expect(schema.parse({ item: null })).toEqual({});
    expect(schema.toJSONSchema().properties!.item).toEqual({
      description: "An item",
      type: ["string", "null"],
    });
  });

  test("ignores annotations, x- keywords and ignoreKeywords", () => {
    const schema = s.fromJSONSchema(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Item",
        type: "object",
        "x-order": ["a"],
        "ui:widget": "text",
        properties: { a: { type: "string", default: "x", examples: ["y"] } },
      },
      { ignoreKeywords: ["ui:widget"] },
    );
    expect(schema.toJSONSchema()).toEqual({
      type: "object",
      properties: { a: { type: ["string", "null"] } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  test("refuses what s cannot model, listing every problem with its path", () => {
    let thrown: unknown;
    try {
      s.fromJSONSchema({
        type: "object",
        properties: {
          code: { type: "string", pattern: "^[A-Z]+$" },
          ref: { $ref: "#/defs/x" },
          pick: { oneOf: [{ type: "string" }] },
          pair: { type: "array", items: [{ type: "string" }] },
          image: { type: "string", format: "image" },
          count: { type: "number", minLength: 1 },
          any: { type: ["string", "number"] },
          bag: { type: "object", additionalProperties: true },
          nothing: {},
        },
        required: ["missing"],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JSONSchemaError);
    expect((thrown as JSONSchemaError).problems).toEqual([
      "required: lists properties the schema doesn't have: missing",
    ]);

    try {
      s.fromJSONSchema({
        type: "object",
        properties: {
          code: { type: "string", pattern: "^[A-Z]+$" },
          ref: { $ref: "#/defs/x" },
          pick: { oneOf: [{ type: "string" }] },
          pair: { type: "array", items: [{ type: "string" }] },
          image: { type: "string", format: "image" },
          count: { type: "number", minLength: 1 },
          any: { type: ["string", "number"] },
          bag: { type: "object", additionalProperties: true },
          nothing: {},
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as JSONSchemaError).problems).toEqual([
      'properties.code.pattern: "pattern" is not supported by s.fromJSONSchema',
      'properties.ref.$ref: "$ref" is not supported by s.fromJSONSchema',
      'properties.pick.oneOf: "oneOf" is not supported by s.fromJSONSchema',
      'properties.pair.items: an array needs "items" to be one schema (tuples are not supported)',
      'properties.image.format: unknown format "image"; pass a check for it in the formats option',
      'properties.count.minLength: "minLength" applies to type string, and this schema is type number',
      'properties.any.type: type ["string","number"] is not supported; only one type, optionally with "null". Use anyOf for alternatives',
      "properties.bag.additionalProperties: only false is supported; a record with arbitrary keys has no strict-mode form (use s.json())",
      "properties.nothing: a schema needs a type, an enum, a const or an anyOf",
    ]);
    expect((thrown as Error).message).toContain("s.fromJSONSchema cannot model this schema");
  });

  test("refuses a non-object", () => {
    expect(() => s.fromJSONSchema("string")).toThrow(JSONSchemaError);
    expect(() => s.fromJSONSchema({ type: "null" })).toThrow(/type "null" is not supported/);
  });
});

/**
 * `unknownKeys` (#753): kyte refuses a form submission carrying a field the
 * form doesn't have, rather than losing what the visitor typed.
 */
describe("s.fromJSONSchema unknownKeys", () => {
  const order = {
    type: "object",
    properties: {
      name: { type: "string" },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: { sku: { type: "string" }, qty: { type: "integer" } },
          required: ["sku", "qty"],
          additionalProperties: false,
        },
      },
      // No `additionalProperties` here: every object in `s` is closed anyway.
      address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      pick: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "a" }, a: { type: "string" } },
            required: ["kind", "a"],
          },
          {
            type: "object",
            properties: { kind: { const: "b" }, b: { type: "number" } },
            required: ["kind", "b"],
          },
        ],
      },
    },
    required: ["name"],
    additionalProperties: false,
  };
  const value = {
    name: "x",
    extra: 1,
    lines: [{ sku: "s", qty: 1, color: "red" }],
    address: { city: "Berlin", zip: "10115" },
    pick: { kind: "b", b: 2, c: true },
  };

  test("strip is the default and drops unknown keys at every depth", () => {
    const expected = {
      ok: true,
      value: {
        name: "x",
        lines: [{ sku: "s", qty: 1 }],
        address: { city: "Berlin" },
        pick: { kind: "b", b: 2 },
      },
    };
    expect(s.fromJSONSchema(order).validate(value)).toEqual(expected);
    expect(s.fromJSONSchema(order, { unknownKeys: "strip" }).validate(value)).toEqual(expected);
  });

  test("error reports each unknown key with its path, Ajv's code and params", () => {
    const schema = s.fromJSONSchema(order, { unknownKeys: "error" });
    const result = schema.validate(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ path, code, params }) => ({ path, code, params }))).toEqual([
      {
        path: ["lines", 0, "color"],
        code: "additionalProperties",
        params: { additionalProperty: "color" },
      },
      {
        path: ["address", "zip"],
        code: "additionalProperties",
        params: { additionalProperty: "zip" },
      },
      // The union's members are closed too, so no variant matched and the
      // closest one (the `kind` it named) is blamed.
      {
        path: ["pick"],
        code: "anyOf",
        params: {
          closest: [
            {
              path: ["pick", "c"],
              code: "additionalProperties",
              message: "unknown key",
              params: { additionalProperty: "c" },
            },
          ],
        },
      },
      { path: ["extra"], code: "additionalProperties", params: { additionalProperty: "extra" } },
    ]);
    expect(schema.safeParse({ name: "x", extra: 1 })).toEqual({
      ok: false,
      errors: ["extra: unknown key"],
    });
    expect(() => schema.parse({ name: "x", extra: 1 })).toThrow("extra: unknown key");
  });

  test("error passes a value with only declared keys, and treats undefined as absent", () => {
    const schema = s.fromJSONSchema(order, { unknownKeys: "error" });
    expect(schema.validate({ name: "x", address: { city: "B" }, extra: undefined })).toEqual({
      ok: true,
      value: { name: "x", address: { city: "B" } },
    });
  });

  test("error is reported beside the other issues of the same object", () => {
    const schema = s.fromJSONSchema(order, { unknownKeys: "error" });
    const result = schema.validate({ name: 1, extra: "y" });
    expect(result.ok === false && result.issues.map((i) => [i.path, i.code])).toEqual([
      [["name"], "type"],
      [["extra"], "additionalProperties"],
    ]);
  });

  test("passthrough keeps unknown keys, checked only for being JSON", () => {
    const schema = s.fromJSONSchema(order, { unknownKeys: "passthrough" });
    expect(schema.validate(value)).toEqual({ ok: true, value });
    const bad = schema.validate({ name: "x", extra: 1n });
    expect(bad.ok === false && bad.issues.map((i) => [i.path, i.code])).toEqual([
      [["extra"], "type"],
    ]);
  });

  test("passthrough keeps a __proto__ key as a key, not a prototype", () => {
    const schema = s.fromJSONSchema(order, { unknownKeys: "passthrough" });
    const result = schema.parse(JSON.parse('{"name":"x","__proto__":{"polluted":true}}')) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect((result as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("the emitted schema and strictness don't change", () => {
    for (const unknownKeys of ["strip", "error", "passthrough"] as const) {
      const schema = s.fromJSONSchema(order, { unknownKeys });
      expect(schema.toJSONSchema()).toEqual(s.fromJSONSchema(order).toJSONSchema());
      expect(supportsStrict(schema)).toBe(true);
    }
  });

  test("the policy belongs to the schema's own objects, through s.object and s.recursive", () => {
    const item = s.fromJSONSchema<{ label: string }>(
      { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      { unknownKeys: "error" },
    );
    type Node = { item: { label: string }; children: Node[] };
    const tree = s.recursive<Node>("Node", (self) => s.object({ item, children: s.array(self) }));
    const result = tree.validate({
      item: { label: "root" },
      // The s.object around the item strips, as builders always do.
      stray: 1,
      children: [
        { item: { label: "a" }, children: [{ item: { label: "b", x: 1 }, children: [] }] },
      ],
    });
    expect(result.ok === false && result.issues.map((i) => [i.path, i.code])).toEqual([
      [["children", 0, "children", 0, "item", "x"], "additionalProperties"],
    ]);
    expect(tree.validate({ item: { label: "root" }, stray: 1, children: [] })).toEqual({
      ok: true,
      value: { item: { label: "root" }, children: [] },
    });
  });

  test("refuses an unknown policy", () => {
    expect(() =>
      s.fromJSONSchema({ type: "string" }, { unknownKeys: "report" as "error" }),
    ).toThrow(/unknownKeys option must be one of "strip", "error", "passthrough", got "report"/);
  });
});
