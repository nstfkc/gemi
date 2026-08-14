import { describe, expectTypeOf, test } from "vitest";
import type { CreateFeatures } from "./FeatureRouter";
import { FeatureRouter } from "./FeatureRouter";

class BillingFeatures extends FeatureRouter {
  features = {
    "new-invoice": this.boolean(false),
    "seat-limit": this.number(5),
  };
}

class AppFeatures extends FeatureRouter {
  features = {
    "new-checkout": this.boolean(false),
    "pricing-page": this.variant(["a", "b", "control"], "control"),
    tier: this.string("free"),
    "billing/": BillingFeatures,
  };
}

type Flags = CreateFeatures<AppFeatures>;

describe("CreateFeatures", () => {
  test("each flag resolves to its declared value type", () => {
    expectTypeOf<Flags["new-checkout"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Flags["tier"]>().toEqualTypeOf<string>();
    expectTypeOf<Flags["billing/seat-limit"]>().toEqualTypeOf<number>();
  });

  test("variant preserves the literal union rather than widening to string", () => {
    // The `const` type parameter on `variant` is what makes this hold. Without
    // it this is `string`, and every `switch` over the flag loses exhaustiveness.
    expectTypeOf<Flags["pricing-page"]>().toEqualTypeOf<"a" | "b" | "control">();
    expectTypeOf<Flags["pricing-page"]>().not.toEqualTypeOf<string>();
  });

  test("nested routers contribute prefixed keys", () => {
    expectTypeOf<Flags["billing/new-invoice"]>().toEqualTypeOf<boolean>();
  });

  test("the key set is exactly the declared flags", () => {
    expectTypeOf<keyof Flags>().toEqualTypeOf<
      "new-checkout" | "pricing-page" | "tier" | "billing/new-invoice" | "billing/seat-limit"
    >();
  });

  test("an undeclared key is not part of the map", () => {
    // @ts-expect-error - "typo" was never declared, so indexing it must fail.
    expectTypeOf<Flags["typo"]>().toBeAny();
  });

  test("the nested router's own key is not itself a flag", () => {
    // @ts-expect-error - "billing/" is a namespace, not a flag.
    expectTypeOf<Flags["billing/"]>().toBeAny();
  });

  test("an empty router declares no flags", () => {
    expectTypeOf<keyof CreateFeatures<FeatureRouter>>().toEqualTypeOf<never>();
  });
});
