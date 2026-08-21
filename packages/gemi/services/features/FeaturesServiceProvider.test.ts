import { beforeEach, describe, expect, test, vi } from "vitest";

const warning = vi.fn();
vi.mock("../../facades/Log", () => ({ Log: { warning, error: vi.fn() } }));

const { FeaturesServiceProvider } = await import("./FeaturesServiceProvider");
const { DatabaseFeatureFlagSource } = await import("./sources/DatabaseFeatureFlagSource");
const { StaticFeatureFlagSource } = await import("./sources/StaticFeatureFlagSource");
const { FeatureManager } = await import("./FeatureManager");
const { defineFeature } = await import("./defineFeature");

/**
 * Resolves the `FeatureManager` the provider would bind, with `slice` standing
 * in for `app/config/features.ts`. Only `register()` runs, so nothing touches
 * the database.
 */
function resolve(slice: Record<string, unknown>) {
  let factory: () => any = () => {
    throw new Error("nothing was bound");
  };
  const app = {
    singleton: (_token: unknown, fn: () => any) => {
      factory = fn;
    },
    config: { get: () => slice },
  } as any;

  new FeaturesServiceProvider(app).register();
  return factory() as InstanceType<typeof FeatureManager>;
}

const source = (manager: any) => manager.config.source;

describe("resolving the source", () => {
  beforeEach(() => warning.mockClear());

  test("defaults to the local FeatureFlag table", () => {
    const s = source(resolve({ features: {} }));

    expect(s).toBeInstanceOf(DatabaseFeatureFlagSource);
    expect(s.modelName).toBe("FeatureFlag");
  });

  test("`model` alone repoints the default source", () => {
    // Otherwise renaming the table would silently do nothing: the default source
    // is built before the app's config is merged over it.
    const s = source(resolve({ features: {}, model: "Flags" }));

    expect(s).toBeInstanceOf(DatabaseFeatureFlagSource);
    expect(s.modelName).toBe("Flags");
  });

  test("`source` alone is kept, and is not repointed at the default model", () => {
    // The regression this exists for. `model` is always set after merging — it
    // defaults to "FeatureFlag" — so comparing the merged value against the
    // source's name fired for an app that had configured only a source, threw
    // that source away, and pointed the replacement at a table the app never
    // mentioned. Every feature then read off with nothing to explain why.
    const s = source(resolve({ features: {}, source: new DatabaseFeatureFlagSource("Flags") }));

    expect(s.modelName).toBe("Flags");
  });

  test("a source that is not the database survives untouched", () => {
    const configured = new StaticFeatureFlagSource({ "new-checkout": true });
    expect(source(resolve({ features: {}, source: configured }))).toBe(configured);
  });

  test("an explicit source wins over `model`, and the contradiction is reported", () => {
    const configured = new DatabaseFeatureFlagSource("Flags");
    const s = source(resolve({ features: {}, model: "Other", source: configured }));

    expect(s).toBe(configured);
    expect(warning.mock.calls.flat().join(" ")).toMatch(/Flags/);
  });

  test("agreeing `model` and `source` do not warn", () => {
    resolve({
      features: {},
      model: "Flags",
      source: new DatabaseFeatureFlagSource("Flags"),
    });

    expect(warning).not.toHaveBeenCalled();
  });
});

describe("the declarations", () => {
  test("reach the manager", () => {
    const features = { "new-checkout": defineFeature() };
    expect(resolve({ features }).declarations()).toBe(features);
  });
});
