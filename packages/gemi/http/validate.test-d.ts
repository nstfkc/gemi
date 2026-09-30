import { expectTypeOf, test } from "vitest";

import type { SchemaKey } from "./HttpRequest";
import type { RULES } from "./validate";

/** `min:${number}` → `min`. */
type RuleName<K> = K extends `${infer R}:${string}` ? R : K;

test("SchemaKey offers exactly the rules validate implements (#609)", () => {
  // `string` and `boolean` were in `SchemaKey` with no case in `validate`, and
  // `email` and `password` were in `validate` with no entry in `SchemaKey`.
  expectTypeOf<RuleName<SchemaKey>>().toEqualTypeOf<(typeof RULES)[number]>();
});
