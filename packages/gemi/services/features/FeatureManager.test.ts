import { describe, expect, test, vi } from "vitest";
import { RequestContext } from "../../http/requestContext";
import { featuresConfigDefaults, type FeaturesConfig } from "./config";
import { defineFeature } from "./defineFeature";
import { FeatureManager } from "./FeatureManager";
import { StaticFeatureFlagSource } from "./sources/StaticFeatureFlagSource";

const AppFeatures = {
  "new-checkout": defineFeature(),
  "pricing-redesign": defineFeature({ rollout: 50 }),
  "internal-tools": defineFeature({ serverOnly: true }),
  "admin-only": defineFeature({ when: (ctx) => ctx.user?.globalRole === 0 }),
};

function manager(
  active: Record<string, boolean> = {},
  overrides: Partial<FeaturesConfig> = {},
  log = () => {},
) {
  return new FeatureManager(
    {
      ...featuresConfigDefaults(),
      features: AppFeatures,
      source: new StaticFeatureFlagSource(active),
      ...overrides,
    } as any,
    log,
  );
}

function fakeRequest(cookies: Record<string, string> = { session_id: "anon-1" }) {
  return {
    routePath: "/pricing",
    rawRequest: { url: "https://example.test/pricing", headers: new Headers() },
    cookies: {
      get: (n: string) => cookies[n],
      has: (n: string) => n in cookies,
    },
  } as any;
}

const inRequest = <T>(fn: () => Promise<T>, req = fakeRequest()) =>
  RequestContext.run(req, fn) as Promise<T>;

describe("the switch", () => {
  test("a feature with no row is off", async () => {
    expect(await manager().enabled("new-checkout")).toBe(false);
  });

  test("a row turns it on", async () => {
    expect(await manager({ "new-checkout": true }).enabled("new-checkout")).toBe(true);
  });

  test("active:false is the kill switch, even against a `when` that says yes", async () => {
    const features = manager({ "admin-only": false });

    const result = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u1", globalRole: 0 });
      return features.enabled("admin-only");
    });

    expect(result).toBe(false);
  });

  test("an undeclared key reads off rather than throwing", async () => {
    expect(await manager().explain("never-declared")).toEqual({
      value: false,
      reason: "undeclared",
    });
  });

  test("evaluating outside a request works", async () => {
    // A job or a cron tick has no request store.
    expect(await manager({ "new-checkout": true }).enabled("new-checkout")).toBe(true);
  });

  test("config.enabled false reads off everywhere and queries nothing", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");
    const features = manager({}, { enabled: false, source });

    expect(await features.enabled("new-checkout")).toBe(false);
    expect(await features.forClient()).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });
});

describe("attribution", () => {
  test("`when` is evaluated against the request user", async () => {
    const features = manager({ "admin-only": true });

    const asAdmin = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u1", globalRole: 0 });
      return features.enabled("admin-only");
    });
    const asUser = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u2", globalRole: 2 });
      return features.enabled("admin-only");
    });

    expect(asAdmin).toBe(true);
    expect(asUser).toBe(false);
  });

  test("attributes from the context hook are readable in `when`", async () => {
    const features = new FeatureManager(
      {
        ...featuresConfigDefaults(),
        features: {
          pro: defineFeature({ when: (ctx) => ctx.attributes.plan === "pro" }),
        },
        source: new StaticFeatureFlagSource({ pro: true }),
        context: () => ({ plan: "pro" }),
      } as any,
      () => {},
    );

    expect(await inRequest(() => features.enabled("pro"))).toBe(true);
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

  test("a rollout is stable across requests for one visitor", async () => {
    const features = manager({ "pricing-redesign": true });

    const first = await inRequest(() => features.enabled("pricing-redesign"));
    const second = await inRequest(() => features.enabled("pricing-redesign"));

    expect(second).toBe(first);
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
      await features.explain("new-checkout");
    });

    expect(onEvaluate).toHaveBeenCalledTimes(1);
  });

  test("forClient does not re-notify a key a handler already read", async () => {
    // The real request shape: a handler branches on a feature, then the
    // dispatcher builds the SSR payload. `forClient` used to bypass the memo
    // entirely, so every such request emitted two exposures for one viewer.
    const features = manager({ "new-checkout": true });
    const onEvaluate = vi.fn();
    (features.config as any).onEvaluate = onEvaluate;

    await inRequest(async () => {
      await features.enabled("new-checkout");
      await features.forClient();
    });

    expect(onEvaluate.mock.calls.filter(([key]) => key === "new-checkout")).toHaveLength(1);
  });

  test("an explicit subject is neither served from nor written to the request memo", async () => {
    // `Features.for(...)` asks what somebody *else* would see. Sharing the
    // ambient memo would cross the two answers in both directions.
    const features = manager({ "pricing-redesign": true });
    const onEvaluate = vi.fn();
    (features.config as any).onEvaluate = onEvaluate;

    await inRequest(async () => {
      await features.enabled("pricing-redesign");
      await features.for({ user: { id: "someone-else" } }).enabled("pricing-redesign");
      await features.enabled("pricing-redesign");
    });

    expect(onEvaluate).toHaveBeenCalledTimes(2);
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
  test("carries every client-visible feature as key to boolean", async () => {
    const features = manager({ "new-checkout": true });
    const payload = await inRequest(() => features.forClient());

    expect(Object.keys(payload).sort()).toEqual(["admin-only", "new-checkout", "pricing-redesign"]);
    expect(payload["new-checkout"]).toBe(true);
  });

  test("omits server-only features", async () => {
    const features = manager({ "internal-tools": true });
    const payload = await inRequest(() => features.forClient());

    expect(payload).not.toHaveProperty("internal-tools");
    // Still evaluable on the server.
    expect(await inRequest(() => features.enabled("internal-tools"))).toBe(true);
  });

  test("carries no reasons — only booleans", async () => {
    const features = manager({
      "new-checkout": true,
      "pricing-redesign": true,
    });
    const payload = await inRequest(() => features.forClient());

    for (const value of Object.values(payload)) {
      expect(typeof value).toBe("boolean");
    }
    // `reason` distinguishes "targeted by name" from "landed in the rollout",
    // which is a fact about the viewer.
    expect(JSON.stringify(payload)).not.toMatch(/reason|rollout|attributed/);
  });

  test("warns once above the client feature threshold", async () => {
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
    const features = manager({ "admin-only": true });

    const result = await inRequest(async () => {
      RequestContext.getStore().setUser({ publicId: "u1", globalRole: 2 });
      return features.for({ user: { publicId: "admin", globalRole: 0 } }).enabled("admin-only");
    });

    expect(result).toBe(true);
  });

  test("for().all() includes server-only features", async () => {
    const features = manager({ "internal-tools": true });

    expect(await features.for({ user: null }).all()).toHaveProperty("internal-tools", true);
  });

  test("subjectId drives bucketing when there is no user", async () => {
    const features = manager({ "pricing-redesign": true });

    const first = await features.for({ subjectId: "org_1" }).enabled("pricing-redesign");
    const again = await features.for({ subjectId: "org_1" }).enabled("pricing-redesign");

    expect(again).toBe(first);
  });

  test("explain reports why", async () => {
    const features = manager({ "new-checkout": true });

    expect(await features.for({ user: null }).explain("new-checkout")).toEqual({
      value: true,
      reason: "on",
    });
  });
});

describe("declarations", () => {
  test("exposes the declared features for tooling", () => {
    expect(Object.keys(manager().declarations()).sort()).toEqual([
      "admin-only",
      "internal-tools",
      "new-checkout",
      "pricing-redesign",
    ]);
  });

  test("no declarations means no queries", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");
    const features = new FeatureManager(
      { ...featuresConfigDefaults(), features: undefined, source } as any,
      () => {},
    );

    await features.refresh();

    expect(Object.keys(features.declarations()).length).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(await features.forClient()).toEqual({});
  });
});

describe("list", () => {
  test("describes every declared feature", async () => {
    const features = new FeatureManager(
      {
        ...featuresConfigDefaults(),
        features: {
          "new-checkout": defineFeature({
            describe: "Rebuilt checkout",
            rollout: 20,
            salt: "checkout-v2",
          }),
          "admin-only": defineFeature({ when: () => true }),
          "internal-tools": defineFeature({ serverOnly: true }),
        },
        source: new StaticFeatureFlagSource({ "new-checkout": true }),
      } as any,
      () => {},
    );

    expect(await features.list()).toEqual([
      {
        key: "new-checkout",
        describe: "Rebuilt checkout",
        rollout: 20,
        targeted: false,
        serverOnly: false,
        salt: "checkout-v2",
        active: true,
      },
      {
        key: "admin-only",
        describe: undefined,
        rollout: undefined,
        targeted: true,
        serverOnly: false,
        salt: undefined,
        active: undefined,
      },
      {
        key: "internal-tools",
        describe: undefined,
        rollout: undefined,
        targeted: false,
        serverOnly: true,
        salt: undefined,
        active: undefined,
      },
    ]);
  });

  test("a feature with no row is not a feature switched off", async () => {
    const [untouched, off] = await manager({ "pricing-redesign": false }).list();

    // The distinction an admin list exists to show: nobody has touched
    // `new-checkout`, whereas somebody decided `pricing-redesign` is off.
    expect(untouched.active).toBe(undefined);
    expect(off.active).toBe(false);
  });

  test("lists server-only features, which `forClient` omits", async () => {
    const features = manager({ "internal-tools": true });

    expect((await features.list()).map((f) => f.key)).toContain("internal-tools");
    expect(await inRequest(() => features.forClient())).not.toHaveProperty("internal-tools");
  });

  test("the declarations still list when the subsystem is off, without a query", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");
    const features = manager({}, { enabled: false, source });

    const list = await features.list();

    expect(list.map((f) => f.key)).toEqual([
      "new-checkout",
      "pricing-redesign",
      "internal-tools",
      "admin-only",
    ]);
    // `enabled: false` means nothing reads the table, so every switch is
    // unknown rather than off — the code declarations are all there is to show.
    expect(list.every((f) => f.active === undefined)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  test("no declarations, no list and no query", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");
    const features = new FeatureManager(
      { ...featuresConfigDefaults(), features: undefined, source } as any,
      () => {},
    );

    expect(await features.list()).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("invalidate", () => {
  test("picks up a write the TTL would have hidden", async () => {
    let active = false;
    const source = new (class extends StaticFeatureFlagSource {
      async load() {
        return [{ key: "new-checkout", active }];
      }
    })();
    const features = manager({}, { source, ttl: 3600 });

    expect(await features.enabled("new-checkout")).toBe(false);

    active = true;
    await features.invalidate();

    expect(await features.enabled("new-checkout")).toBe(true);
  });

  test("does not settle on a load that started before the write", async () => {
    let active = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const source = new (class extends StaticFeatureFlagSource {
      async load() {
        // Read at entry: the first load queried the table before the write and
        // returns long after it.
        const seen = active;
        if (first) {
          first = false;
          await gate;
        }
        return [{ key: "new-checkout", active: seen }];
      }
    })();
    const features = manager({}, { source, ttl: 3600 });

    // A load is already in flight, reading the table as it was before the write.
    const inflight = features.refresh();

    active = true;
    const invalidated = features.invalidate();
    release();
    await inflight;
    await invalidated;

    // `refresh()` would have resolved on the in-flight load and reported the
    // pre-write value; the admin's own write has to be visible to the admin.
    expect(await features.enabled("new-checkout")).toBe(true);
  });

  test("re-evaluates a feature the request already read", async () => {
    let active = false;
    const source = new (class extends StaticFeatureFlagSource {
      async load() {
        return [{ key: "new-checkout", active }];
      }
    })();
    const features = manager({}, { source, ttl: 3600 });

    const [before, after] = await inRequest(async () => {
      const before = await features.enabled("new-checkout");
      active = true;
      await features.invalidate();
      return [before, await features.enabled("new-checkout")];
    });

    // Without clearing the per-request memo the second read would be answered
    // from the first, and a handler could never see its own write.
    expect(before).toBe(false);
    expect(after).toBe(true);
  });

  test("touches nothing when the subsystem is off", async () => {
    const source = new StaticFeatureFlagSource({ "new-checkout": true });
    const load = vi.spyOn(source, "load");

    await manager({}, { enabled: false, source }).invalidate();

    expect(load).not.toHaveBeenCalled();
  });
});
