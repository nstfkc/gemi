import { describe, expectTypeOf, test } from "vitest";

import { useFeature } from "gemi/client";
import { Features } from "gemi/facades";

import AppFeatures from "./index";

/**
 * **What the feature keys are typed as, from inside a real application.**
 *
 * This can only be checked here. `CreateFeatures` lives in the framework, but
 * the `Features` interface it feeds is augmented by `gemi.d.ts` against
 * `@/app/features` — a path that resolves through *this* package's tsconfig. A
 * test in `packages/gemi` sees an empty `Features`, where every key type
 * degrades to `string` and every assertion below passes vacuously.
 */
describe("feature keys", () => {
  test("a declared key is accepted on both surfaces", () => {
    expectTypeOf(useFeature).toBeCallableWith("new-checkout");
    expectTypeOf(Features.enabled).toBeCallableWith("new-checkout");
  });

  test("useFeature returns a boolean", () => {
    expectTypeOf(useFeature("new-checkout")).toEqualTypeOf<boolean>();
  });

  test("a typo is a compile error rather than a feature that reads as off", () => {
    // @ts-expect-error - not a declared key
    useFeature("pricing-redesgin");
    // @ts-expect-error - not a declared key
    Features.enabled("nope");
  });

  test("a serverOnly key is server-side only, and the type says so", () => {
    // Declared, evaluated, and readable through the facade.
    expectTypeOf(Features.enabled).toBeCallableWith("project-nightingale");

    // But withheld from the SSR payload, so a client read could only ever
    // answer `false`. The compile error is the whole point: without it this is
    // a silent wrong answer plus a runtime warning telling you to declare a
    // feature you already declared.
    // @ts-expect-error - `serverOnly: true`, so it never reaches the browser
    useFeature("project-nightingale");
  });

  test("serverOnly is carried in the declaration's type, not just its value", () => {
    expectTypeOf(AppFeatures["project-nightingale"].serverOnly).toEqualTypeOf<true>();
    expectTypeOf(AppFeatures["new-checkout"].serverOnly).toEqualTypeOf<false>();
  });
});
