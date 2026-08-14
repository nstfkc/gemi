import { describe, expect, test, vi } from "vitest";
import { FeatureRouter } from "../../http/FeatureRouter";
import { RequestContext } from "../../http/requestContext";
import { featuresConfigDefaults, type FeaturesConfig } from "./config";
import { FeatureManager } from "./FeatureManager";
import { StaticFeatureFlagSource, type StaticFlag } from "./sources/StaticFeatureFlagSource";

class AppFeatures extends FeatureRouter {
  features = {
    "new-checkout": this.boolean(false),
    "pricing-page": this.variant(["a", "b", "control"], "control"),
    "internal-tools": this.boolean(false).serverOnly(),
    "seat-limit": this.number(5),
  };
}

function manager(
  flags: Record<string, StaticFlag> = {},
  overrides: Partial<FeaturesConfig> = {},
  log = () => {},
) {
  return new FeatureManager(
    {
      ...featuresConfigDefaults(),
      router: AppFeatures,
      source: new StaticFeatureFlagSource(flags),
      ...overrides,
    } as any,
    log,
  );
}

function fakeRequest(cookies: Record<string, string> = { session_id: "anon-1" }) {
  return {
    routePath: "/pricing",
    rawRequest: { url: "https://example.test/pricing", headers: new Headers() },
    cookies: { get: (n: string) => cookies[n], has: (n: string) => n in cookies },
  } as any;
}

const inRequest = <T,>(fn: () => Promise<T>, req = fakeRequest()) =>
  RequestContext.run(req, fn) as Promise<T>;

describe("defaults", () => {
  test("an unconfigured flag resolves to its declared default", async () => {
    const features = manager();

    expect(await features.value("pricing-page")).toBe("control");
    expect(await features.enabled("new-checkout")).toBe(false);
    expect(await features.value("seat-limit")).toBe(5);
  });

  test("an undeclared key resolves to null rather than throwing", async () => {
    const result = await manager().explain("never-declared");

    expect(result).toEqual({ value: null, reason: "unknown", ruleId: null });
  });

  test("evaluating outside a request works", async () => {
    // A job or a cron tick has no request store.
    const features = manager({ "new-checkout": true });

    expect(await features.enabled("new-checkout")).toBe(true);
  });

  test("config.enabled false serves declared defaults and queries nothing", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");
    const features = manager({}, { enabled: false, source });

    expect(await features.enabled("new-checkout")).toBe(false);
    expect(await features.forClient()).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });
});

describe("evaluation", () => {
  test("a row turns a flag on", async () => {
    const features = manager({ "new-checkout": true });

    expect(await features.enabled("new-checkout")).toBe(true);
  });

  test("enabled:false is the kill switch", async () => {
    const features = manager({
      "new-checkout": { enabled: false, rules: [{ id: "r", value: true }] },
    });

    expect(await features.enabled("new-checkout")).toBe(false);
  });

  test("rules are evaluated against the request user", async () => {
    const features = manager({
      "new-checkout": {
        rules: [
          {
            id: "r1",
            conditions: [{ attribute: "user.globalRole", operator: "eq", value: 0 }],
            value: true,
          },
        ],
      },
    });

    const asAdmin = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u1", globalRole: 0 });
      return features.enabled("new-checkout");
    });
    const asUser = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u2", globalRole: 2 });
      return features.enabled("new-checkout");
    });

    expect(asAdmin).toBe(true);
    expect(asUser).toBe(false);
  });

  test("attributes from the context hook are targetable", async () => {
    const features = manager(
      {
        "new-checkout": {
          rules: [
            { id: "r1", conditions: [{ attribute: "plan", operator: "eq", value: "pro" }], value: true },
          ],
        },
      },
      { context: () => ({ plan: "pro" }) },
    );

    expect(await inRequest(() => features.enabled("new-checkout"))).toBe(true);
  });

  test("a throwing context hook degrades instead of breaking the request", async () => {
    const log = vi.fn();
    const features = manager(
      { "new-checkout": true },
      {
        context: () => {
          throw new Error("upstream down");
        },
      },
      log,
    );

    expect(await inRequest(() => features.enabled("new-checkout"))).toBe(true);
    expect(log.mock.calls.flat().join(" ")).toMatch(/context/i);
  });
});

describe("per-request memoization", () => {
  test("one evaluation per key per request", async () => {
    const features = manager({ "new-checkout": true });
    const onEvaluate = vi.fn();
    (features.config as any).onEvaluate = onEvaluate;

    await inRequest(async () => {
      await features.enabled("new-checkout");
      await features.enabled("new-checkout");
      await features.value("new-checkout");
    });

    expect(onEvaluate).toHaveBeenCalledTimes(1);
  });

  test("a different request evaluates again", async () => {
    const features = manager({ "new-checkout": true });
    const onEvaluate = vi.fn();
    (features.config as any).onEvaluate = onEvaluate;

    await inRequest(() => features.enabled("new-checkout"));
    await inRequest(() => features.enabled("new-checkout"));

    expect(onEvaluate).toHaveBeenCalledTimes(2);
  });

  test("a throwing onEvaluate hook does not break evaluation", async () => {
    const log = vi.fn();
    const features = manager({ "new-checkout": true }, {}, log);
    (features.config as any).onEvaluate = () => {
      throw new Error("analytics down");
    };

    expect(await inRequest(() => features.enabled("new-checkout"))).toBe(true);
    expect(log.mock.calls.flat().join(" ")).toMatch(/onEvaluate/);
  });
});

describe("forClient", () => {
  test("carries every client-visible flag as key to value", async () => {
    const features = manager({ "new-checkout": true });
    const payload = await inRequest(() => features.forClient());

    expect(payload).toEqual({
      "new-checkout": true,
      "pricing-page": "control",
      "seat-limit": 5,
    });
  });

  test("omits server-only flags", async () => {
    const features = manager({ "internal-tools": true });
    const payload = await inRequest(() => features.forClient());

    expect(payload).not.toHaveProperty("internal-tools");
    // Still evaluable on the server.
    expect(await inRequest(() => features.enabled("internal-tools"))).toBe(true);
  });

  test("carries no rule metadata, seeds or reasons", async () => {
    const features = manager({
      "new-checkout": { seed: "secret-seed", rules: [{ id: "secret-rule", value: true }] },
    });
    const serialized = JSON.stringify(await inRequest(() => features.forClient()));

    for (const leak of ["secret-seed", "secret-rule", "reason", "ruleId", "rules", "conditions"]) {
      expect(serialized, `payload leaked ${leak}`).not.toContain(leak);
    }
  });

  test("the payload is flat scalars only", async () => {
    const payload = await inRequest(() => manager({ "new-checkout": true }).forClient());

    for (const value of Object.values(payload)) {
      expect(["boolean", "string", "number"]).toContain(typeof value);
    }
  });

  test("warns once above the client flag threshold", async () => {
    const log = vi.fn();
    const features = manager({}, { maxClientFlags: 1 }, log);

    await inRequest(() => features.forClient());
    await inRequest(() => features.forClient());

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(" ")).toMatch(/serverOnly/);
  });
});

describe("explicit subjects", () => {
  test("for() ignores the ambient request", async () => {
    const features = manager({
      "new-checkout": {
        rules: [
          {
            id: "r1",
            conditions: [{ attribute: "user.globalRole", operator: "eq", value: 0 }],
            value: true,
          },
        ],
      },
    });

    const result = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u1", globalRole: 2 });
      return features.for({ user: { publicId: "admin", globalRole: 0 } }).enabled("new-checkout");
    });

    expect(result).toBe(true);
  });

  test("for().all() includes server-only flags", async () => {
    const features = manager({ "internal-tools": true });

    expect(await features.for({ user: null }).all()).toHaveProperty("internal-tools", true);
  });

  test("subjectId drives bucketing when there is no user", async () => {
    const features = manager({
      "new-checkout": { rules: [{ id: "r1", rollout: 50, value: true }] },
    });

    const first = await features.for({ subjectId: "org_1" }).enabled("new-checkout");
    const again = await features.for({ subjectId: "org_1" }).enabled("new-checkout");

    expect(again).toBe(first);
  });
});

describe("declarations", () => {
  test("exposes the declared flags for tooling", () => {
    expect([...manager().declarations().keys()].sort()).toEqual([
      "internal-tools",
      "new-checkout",
      "pricing-page",
      "seat-limit",
    ]);
  });

  test("no router means no flags and no queries", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");
    const features = new FeatureManager(
      { ...featuresConfigDefaults(), router: undefined, source } as any,
      () => {},
    );

    await features.refresh();

    expect(features.declarations().size).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(await features.forClient()).toEqual({});
  });
});
