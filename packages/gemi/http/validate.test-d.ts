import { expectTypeOf, test } from "vitest";

import type { Schema, SchemaKey } from "./HttpRequest";
import type { RULES } from "./validate";

/** `min:${number}` → `min`. */
type RuleName<K> = K extends `${infer R}:${string}` ? R : K;

test("SchemaKey offers exactly the rules validate implements (#609)", () => {
  // `string` and `boolean` were in `SchemaKey` with no case in `validate`, and
  // `email` and `password` were in `validate` with no entry in `SchemaKey`.
  expectTypeOf<RuleName<SchemaKey>>().toEqualTypeOf<(typeof RULES)[number]>();
});

test("Schema<T> takes dotted paths next to the body's own keys (#711)", () => {
  type Body = { name: string; rounds: { prompt: string }[] };
  const schema: Schema<Body> = {
    name: { required: "Name is required" },
    rounds: { array: "Must be a list", "min:1": "Add one" },
    "rounds.*.prompt": { required: "Prompt is required", "in:a,b": "Unknown" },
  };
  expectTypeOf(schema).toMatchTypeOf<Schema<Body>>();
  // @ts-expect-error a key without a dot must be a field of the body
  const typo: Schema<Body> = { name: {}, rounds: {}, round: {} };
  void typo;
});
