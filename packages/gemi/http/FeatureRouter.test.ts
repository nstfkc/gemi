import { describe, expect, test } from "vitest";
import { FeatureFlag, FeatureRouter, flattenFeatures } from "./FeatureRouter";

class BillingFeatures extends FeatureRouter {
  features = {
    "new-invoice": this.boolean(false),
    "seat-limit": this.number(5),
  };
}

class AppFeatures extends FeatureRouter {
  features = {
    "new-checkout": this.boolean(false).describe("Rebuilt checkout"),
    "pricing-page": this.variant(["a", "b", "control"], "control"),
    "internal-tools": this.boolean(false).serverOnly(),
    "billing/": BillingFeatures,
  };
}

describe("flag declaration", () => {
  test("boolean carries its default", () => {
    expect(new FeatureRouter().boolean(true).defaultValue).toBe(true);
    expect(new FeatureRouter().boolean().defaultValue).toBe(false);
  });

  test("variant records the allowed set", () => {
    const flag = new FeatureRouter().variant(["a", "b"], "a");

    expect(flag.defaultValue).toBe("a");
    expect(flag.allowed).toEqual(["a", "b"]);
  });

  test("describe and serverOnly are chainable and return the same flag", () => {
    const flag = new FeatureRouter().boolean(false);
    const chained = flag.describe("why").serverOnly();

    expect(chained).toBe(flag);
    expect(flag.description).toBe("why");
    expect(flag.isServerOnly).toBe(true);
  });

  test("flags are not server-only by default", () => {
    expect(new FeatureRouter().boolean(false).isServerOnly).toBe(false);
  });
});

describe("flattenFeatures", () => {
  const flat = flattenFeatures(new AppFeatures());

  test("collects top-level flags", () => {
    expect(flat.get("new-checkout")).toBeInstanceOf(FeatureFlag);
    expect(flat.get("new-checkout")!.defaultValue).toBe(false);
  });

  test("prefixes nested router keys", () => {
    expect([...flat.keys()].sort()).toEqual([
      "billing/new-invoice",
      "billing/seat-limit",
      "internal-tools",
      "new-checkout",
      "pricing-page",
    ]);
  });

  test("nested flags keep their declarations", () => {
    expect(flat.get("billing/seat-limit")!.defaultValue).toBe(5);
  });

  test("server-only survives the walk", () => {
    expect(flat.get("internal-tools")!.isServerOnly).toBe(true);
    expect(flat.get("new-checkout")!.isServerOnly).toBe(false);
  });

  test("an empty router is an empty map", () => {
    expect(flattenFeatures(new FeatureRouter()).size).toBe(0);
  });

  test("colliding keys throw rather than silently overwrite", () => {
    class Inner extends FeatureRouter {
      features = { b: this.boolean(false) };
    }
    class Collides extends FeatureRouter {
      features = {
        "a/": Inner,
        // Reaches the same flat key as `a/` + `b`. Silently keeping one would
        // mean a flag the types promise that the runtime never serves.
        "a/b": this.boolean(true),
      };
    }

    expect(() => flattenFeatures(new Collides())).toThrow(/Duplicate feature flag key "a\/b"/);
  });

  test("the runtime walk matches the type-level walk's key set", () => {
    // Guards the drift the two walks are written to avoid: a key the types
    // promise but the runtime never produces is a flag that always returns its
    // default, with no error anywhere.
    const declared: Record<keyof import("./FeatureRouter").CreateFeatures<AppFeatures>, true> = {
      "new-checkout": true,
      "pricing-page": true,
      "internal-tools": true,
      "billing/new-invoice": true,
      "billing/seat-limit": true,
    };

    expect([...flat.keys()].sort()).toEqual(Object.keys(declared).sort());
  });
});
