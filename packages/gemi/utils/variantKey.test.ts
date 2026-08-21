import { describe, expect, test } from "vitest";

import { toVariantKey } from "./variantKey";

/**
 * The one definition of a cache variant key, which used to be a copy each in
 * `useQuery` (the read), `useMutate` (the write) and `<Page>` (the seed).
 *
 * These pin the two properties those copies had to agree on: order-independence
 * and nullish omission. A divergence in either is silent — a write lands under
 * a key no read looks at, or a seed misses and the query goes to the network —
 * so the assertions are here rather than left implied by the call sites.
 */
describe("toVariantKey", () => {
  test("sorts, so param order is not part of the identity", () => {
    expect(toVariantKey({ b: "2", a: "1" })).toBe(
      toVariantKey({ a: "1", b: "2" }),
    );
    expect(toVariantKey({ b: "2", a: "1" })).toBe("a=1&b=2");
  });

  test("drops nullish values rather than stringifying them", () => {
    // An optional filter left unset is absent, not `"undefined"`.
    expect(toVariantKey({ page: "2", q: undefined, tag: null })).toBe("page=2");
  });

  test("is empty when there are no params", () => {
    expect(toVariantKey({})).toBe("");
    expect(toVariantKey(undefined)).toBe("");
    expect(toVariantKey("")).toBe("");
  });

  test("takes the query-string form a seed key carries, sorted the same way", () => {
    expect(toVariantKey("b=2&a=1")).toBe("a=1&b=2");
    expect(toVariantKey("b=2&a=1")).toBe(toVariantKey({ a: "1", b: "2" }));
  });

  test("coerces non-string values the way a URL would", () => {
    expect(toVariantKey({ page: 2, archived: false })).toBe(
      "archived=false&page=2",
    );
  });
});
