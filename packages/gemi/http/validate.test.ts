import { describe, expect, test } from "vitest";

import { validate } from "./validate";

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

describe("the rules that were already right", () => {
  test("number", () => {
    expect(accepts("number")).toEqual(["number 5", "number 0", "number -1"]);
  });

  test("email", () => {
    expect(validate("email")("a@b.co")).toBe(true);
    expect(validate("email")("a@b")).toBe(false);
  });

  test("file", () => {
    expect(validate("file")(new Blob([]))).toBe(true);
    expect(validate("file")("not a file")).toBe(false);
  });
});

describe("a rule nobody implemented", () => {
  test("accepts everything, which is worth knowing about `string` and `boolean`", () => {
    // `SchemaKey` offers `string` and `boolean` and `validate` has no case for
    // either, so both fall to the `default` arm and check nothing. That is not
    // changed here: enforcing them would start rejecting requests that apps
    // currently accept, which is a behaviour change and not a bug fix. This test
    // records the state so the change, when it is made, is made deliberately.
    expect(accepts("string")).toEqual(Object.keys(shapes));
    expect(accepts("boolean")).toEqual(Object.keys(shapes));
  });
});
