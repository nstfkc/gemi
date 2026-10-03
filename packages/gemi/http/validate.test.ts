import { describe, expect, test } from "vitest";

import { InvalidValidationRuleError, RULES, validate } from "./validate";

/**
 * The rule table, over every shape a JSON body can hand it.
 *
 * TABLE-DRIVEN BECAUSE THE FAILURE MODE WAS INVISIBLE FROM THE APP'S SIDE. The
 * bug this file exists for — `required` ending in `value?.length > 0`, so a
 * number, a boolean and an object all failed it — produced a 400 on a correct
 * request, which reads as "my validation rule is working" until someone checks
 * which values it lets through. A test per rule with one happy value would have
 * passed throughout: `required` was always right about strings.
 */

const shapes = {
  "object {a:1}": { a: 1 },
  "object {}": {},
  "number 5": 5,
  "number 0": 0,
  "number -1": -1,
  "boolean true": true,
  "boolean false": false,
  "string 'hi'": "hi",
  "string ''": "",
  "array ['x']": ["x"],
  "array []": [],
  null: null,
  undefined: undefined,
} as const;

/** Which of the shapes above a rule accepts, by name, in table order. */
function accepts(rule: string): string[] {
  const predicate = validate(rule);
  return Object.entries(shapes)
    .filter(([, value]) => predicate(value) === true)
    .map(([name]) => name);
}

describe("required", () => {
  test("accepts every value that is present, and only rejects absence and emptiness", () => {
    expect(accepts("required")).toEqual([
      "object {a:1}",
      // An object that was sent. Whether its contents are adequate is a question
      // for the rules on its fields.
      "object {}",
      "number 5",
      // `0` and `false` are values someone sent. `required` asks whether the
      // field is there, not whether it is truthy — the old rule rejected both,
      // so a quantity of zero and an unchecked box read as missing.
      "number 0",
      "number -1",
      "boolean true",
      "boolean false",
      "string 'hi'",
      "array ['x']",
    ]);
  });

  test("a zero-byte upload is still empty", () => {
    const predicate = validate("required");
    expect(predicate(new Blob(["x"]))).toBe(true);
    expect(predicate(new Blob([]))).toBe(false);
  });
});

describe("min and max measure length, and nothing else", () => {
  test("only strings and arrays have one, so only they can satisfy the rule", () => {
    expect(accepts("min:1")).toEqual(["string 'hi'", "array ['x']"]);
    // `max` is not the negation of `min`: a value with no length satisfies
    // neither, which is the point of answering `undefined` rather than doing
    // arithmetic on it.
    expect(accepts("max:1")).toEqual(["string ''", "array ['x']", "array []"]);
  });

  test("a number is refused by both, rather than quietly passing one", () => {
    expect(validate("min:3")(5)).toBe(false);
    expect(validate("max:3")(5)).toBe(false);
  });

  test("and an object that merely has a `length` field is not a thing with a length", () => {
    // `value?.length` does not ask whether the value HAS a length, it asks for a
    // property — so a JSON body of `{"tags": {"length": 5}}` satisfied `min:3`
    // under the old rule, because the client chose the field name. Reading the
    // length only off the types that have one closes that.
    expect(validate("min:3")({ length: 5 })).toBe(false);
    expect(validate("max:9")({ length: 5 })).toBe(false);
  });
});

describe("gte and lte measure magnitude, and say so in their names", () => {
  test("numbers are compared, including the ones `required` used to reject", () => {
    expect(accepts("gte:0")).toEqual(["number 5", "number 0"]);
    expect(accepts("lte:0")).toEqual(["number 0", "number -1"]);
  });

  test("a string of digits is not a number", () => {
    // The rules do not coerce. A body field that should be numeric says so with
    // the `number` rule; `gte` is about magnitude, not about parsing.
    expect(validate("gte:3")("5")).toBe(false);
    expect(validate("gte:3")(5)).toBe(true);
  });

  test("decimals work, which `min`'s parseInt would have truncated", () => {
    expect(validate("gte:1.5")(1.4)).toBe(false);
    expect(validate("gte:1.5")(1.5)).toBe(true);
    // Both directions: `parseInt("1.5")` is 1, so an lte built on it would
    // accept 1.4 and also 1.5 while claiming a ceiling of 1.
    expect(validate("lte:1.5")(1.6)).toBe(false);
    expect(validate("lte:1.5")(1.5)).toBe(true);
  });

  test("NaN satisfies neither, having no magnitude to compare", () => {
    expect(validate("gte:0")(Number.NaN)).toBe(false);
    expect(validate("lte:0")(Number.NaN)).toBe(false);
  });
});

describe("number", () => {
  test("accepts numbers, and not NaN", () => {
    expect(accepts("number")).toEqual(["number 5", "number 0", "number -1"]);
    expect(validate("number")(Number.NaN)).toBe(false);
    expect(validate("number")("5")).toBe(false);
  });
});

describe("string and boolean check the JSON type (#609)", () => {
  test("string accepts strings, empty included, and nothing else", () => {
    // `""` passes: `string` asks for the type. Emptiness is `required`'s and
    // `min`'s business.
    expect(accepts("string")).toEqual(["string 'hi'", "string ''"]);
  });

  test("boolean accepts true and false, and nothing else", () => {
    expect(accepts("boolean")).toEqual(["boolean true", "boolean false"]);
  });

  test("neither coerces", () => {
    expect(validate("boolean")("true")).toBe(false);
    expect(validate("boolean")("on")).toBe(false);
    expect(validate("boolean")(1)).toBe(false);
    expect(validate("string")(42)).toBe(false);
  });
});

describe("the regex rules", () => {
  test("email", () => {
    expect(validate("email")("a@b.co")).toBe(true);
    expect(validate("email")("a@b")).toBe(false);
  });

  test("password", () => {
    expect(validate("password")("Str0ng!pass")).toBe(true);
    expect(validate("password")("weakpass")).toBe(false);
  });

  test("only test strings, where `RegExp#test` would stringify an array", () => {
    expect(validate("email")(["a@b.co"])).toBe(false);
    expect(validate("password")(["Str0ng!pass"])).toBe(false);
    expect(accepts("email")).toEqual([]);
  });
});

describe("array, object and in (#711)", () => {
  test("object is a plain object: not an array, null or an upload", () => {
    expect(validate("object")({})).toBe(true);
    expect(validate("object")([])).toBe(false);
    expect(validate("object")(null)).toBe(false);
    expect(validate("object")(new Blob(["x"]))).toBe(false);
  });

  test("in compares strings exactly, and a parameter may hold a colon", () => {
    expect(validate("in:question,choice")("choice")).toBe(true);
    expect(validate("in:question,choice")("Choice")).toBe(false);
    expect(validate("in:1,2")(1)).toBe(false);
    expect(validate("in:a:b,c")("a:b")).toBe(true);
  });
});

describe("the file rules", () => {
  const png = new Blob(["x".repeat(2048)], { type: "image/png" });

  test("file", () => {
    expect(validate("file")(new Blob([]))).toBe(true);
    expect(validate("file")("not a file")).toBe(false);
    expect(accepts("file")).toEqual([]);
  });

  test("fileType matches the MIME type, or its family", () => {
    expect(validate("fileType:png")(png)).toBe(true);
    expect(validate("fileType:image")(png)).toBe(true);
    expect(validate("fileType:pdf")(png)).toBe(false);
    expect(accepts("fileType:png")).toEqual([]);
  });

  test("fileSize is a ceiling", () => {
    expect(validate("fileSize:2KB")(png)).toBe(true);
    expect(validate("fileSize:1KB")(png)).toBe(false);
    expect(accepts("fileSize:1MB")).toEqual([]);
  });

  test("they answer false, not undefined, for a value that is not a file", () => {
    expect(validate("fileType:png")("x.png")).toBe(false);
    expect(validate("fileSize:1MB")("x")).toBe(false);
  });
});

/**
 * One case per rule, each run against the full shape table. The completeness
 * check at the bottom fails when `RULES` gains a rule this table does not
 * cover; `validate.test-d.ts` fails when `SchemaKey` and `RULES` disagree.
 */
const everyRule: Record<(typeof RULES)[number], { rule: string; accepts: string[] }> = {
  required: {
    rule: "required",
    accepts: [
      "object {a:1}",
      "object {}",
      "number 5",
      "number 0",
      "number -1",
      "boolean true",
      "boolean false",
      "string 'hi'",
      "array ['x']",
    ],
  },
  string: { rule: "string", accepts: ["string 'hi'", "string ''"] },
  boolean: { rule: "boolean", accepts: ["boolean true", "boolean false"] },
  number: { rule: "number", accepts: ["number 5", "number 0", "number -1"] },
  email: { rule: "email", accepts: [] },
  password: { rule: "password", accepts: [] },
  min: { rule: "min:1", accepts: ["string 'hi'", "array ['x']"] },
  max: { rule: "max:1", accepts: ["string ''", "array ['x']", "array []"] },
  gte: { rule: "gte:0", accepts: ["number 5", "number 0"] },
  lte: { rule: "lte:0", accepts: ["number 0", "number -1"] },
  file: { rule: "file", accepts: [] },
  fileType: { rule: "fileType:png", accepts: [] },
  fileSize: { rule: "fileSize:1MB", accepts: [] },
  array: { rule: "array", accepts: ["array ['x']", "array []"] },
  object: { rule: "object", accepts: ["object {a:1}", "object {}"] },
  in: { rule: "in:hi,x", accepts: ["string 'hi'"] },
};

describe("every rule is implemented", () => {
  test.each(Object.entries(everyRule))("%s", (_name, { rule, accepts: expected }) => {
    expect(accepts(rule)).toEqual(expected);
  });

  test("and the table above covers every rule", () => {
    expect(Object.keys(everyRule).sort()).toEqual([...RULES].sort());
  });
});

describe("a rule the table does not have", () => {
  test("throws, naming the rule and the ones that exist", () => {
    // It used to answer `() => true`, which is how `string` and `boolean` sat
    // in `SchemaKey` checking nothing.
    expect(() => validate("different")).toThrow(InvalidValidationRuleError);
    expect(() => validate("different")).toThrow(
      /Unknown validation rule "different"\. Known rules: required, string, boolean/,
    );
    expect(() => validate("requried")).toThrow(InvalidValidationRuleError);
    expect(() => validate("")).toThrow(InvalidValidationRuleError);
  });

  test("and so does a parameter the rule cannot read", () => {
    // Each of these used to build a predicate that failed every value — NaN
    // for the numeric ones, a 0-byte ceiling for `fileSize`.
    for (const rule of [
      "min",
      "min:",
      "max:abc",
      "gte:x",
      "lte:",
      "fileType",
      "fileSize:5mb",
      "fileSize:1.5MB",
      "fileSize",
      "in",
      "in:",
      "in:,",
    ]) {
      expect(() => validate(rule), rule).toThrow(InvalidValidationRuleError);
    }
    expect(validate("fileSize:0B")(new Blob([]))).toBe(true);
  });
});
