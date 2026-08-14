import { describe, expect, test, vi } from "vitest";
import { FeatureRouter, flattenFeatures } from "../../http/FeatureRouter";
import { FeatureFlagStore } from "./FeatureFlagStore";
import { FeatureFlagSource } from "./sources/FeatureFlagSource";

class Declared extends FeatureRouter {
  features = {
    alpha: this.boolean(false),
    beta: this.boolean(true),
  };
}

const declared = flattenFeatures(new Declared());

class ScriptedSource extends FeatureFlagSource {
  calls = 0;
  constructor(
    private readonly script: () => Promise<Record<string, unknown>[]>,
  ) {
    super();
  }
  async load() {
    this.calls++;
    return await this.script();
  }
}

const rows = (...keys: string[]) => keys.map((key) => ({ key, enabled: true, seed: key }));

describe("loading", () => {
  test("normalizes rows against the declarations", async () => {
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => rows("alpha")),
      declared,
      1000,
    );
    const snapshot = await store.get();

    expect(snapshot.unavailable).toBe(false);
    expect(snapshot.flags.get("alpha")!.enabled).toBe(true);
  });

  test("a row for an undeclared flag is ignored with a warning", async () => {
    const warn = vi.fn();
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => rows("alpha", "ghost")),
      declared,
      1000,
      warn,
    );
    const snapshot = await store.get();

    expect([...snapshot.flags.keys()]).toEqual(["alpha"]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/"ghost"/);
  });

  test("an empty table is a normal, available state", async () => {
    const store = new FeatureFlagStore(new ScriptedSource(async () => []), declared, 1000);
    const snapshot = await store.get();

    expect(snapshot.unavailable).toBe(false);
    expect(snapshot.flags.size).toBe(0);
  });
});

describe("caching", () => {
  test("serves from cache inside the TTL", async () => {
    const source = new ScriptedSource(async () => rows("alpha"));
    const store = new FeatureFlagStore(source, declared, 10_000);

    await store.get();
    await store.get();
    await store.get();

    expect(source.calls).toBe(1);
  });

  test("refreshes in the background once stale, without blocking", async () => {
    let batch = rows("alpha");
    const source = new ScriptedSource(async () => batch);
    const store = new FeatureFlagStore(source, declared, 0);

    await store.get();
    batch = rows("alpha", "beta");

    // Stale: returns the old snapshot immediately rather than awaiting the load.
    const stale = await store.get();
    expect([...stale.flags.keys()]).toEqual(["alpha"]);

    // The background refresh lands, and the next read sees it.
    await store.refresh();
    expect([...(await store.get()).flags.keys()].sort()).toEqual(["alpha", "beta"]);
  });

  test("concurrent cold reads issue one query", async () => {
    let resolve: (rows: Record<string, unknown>[]) => void;
    const pending = new Promise<Record<string, unknown>[]>((r) => {
      resolve = r;
    });
    const source = new ScriptedSource(() => pending);
    const store = new FeatureFlagStore(source, declared, 1000);

    const reads = [store.get(), store.get(), store.get()];
    resolve!(rows("alpha"));
    await Promise.all(reads);

    expect(source.calls).toBe(1);
  });

  test("a later refresh after the in-flight one settles does query again", async () => {
    const source = new ScriptedSource(async () => rows("alpha"));
    const store = new FeatureFlagStore(source, declared, 1000);

    await store.refresh();
    await store.refresh();

    expect(source.calls).toBe(2);
  });
});

describe("failure handling", () => {
  test("a first-load failure reports unavailable rather than throwing", async () => {
    const warn = vi.fn();
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => {
        throw new Error("no database");
      }),
      declared,
      1000,
      warn,
    );

    const snapshot = await store.get();

    expect(snapshot.unavailable).toBe(true);
    expect(snapshot.flags.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  test("a failed refresh keeps the last good snapshot", async () => {
    let fail = false;
    const source = new ScriptedSource(async () => {
      if (fail) throw new Error("database went away");
      return rows("alpha");
    });
    const store = new FeatureFlagStore(source, declared, 0);

    await store.get();
    fail = true;
    const after = await store.refresh();

    // An outage must not read as "every flag reverted to its default".
    expect(after.unavailable).toBe(false);
    expect([...after.flags.keys()]).toEqual(["alpha"]);
  });

  test("a failed refresh backs off for a TTL instead of retrying every read", async () => {
    let fail = false;
    const source = new ScriptedSource(async () => {
      if (fail) throw new Error("down");
      return rows("alpha");
    });
    const store = new FeatureFlagStore(source, declared, 10_000);

    await store.get();
    fail = true;
    await store.refresh();
    const callsAfterFailure = source.calls;

    await store.get();
    await store.get();

    expect(source.calls).toBe(callsAfterFailure);
  });

  test("the failure log is rate-limited to once per TTL", async () => {
    const warn = vi.fn();
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => {
        throw new Error("down");
      }),
      declared,
      10_000,
      warn,
    );

    await store.refresh();
    await store.refresh();
    await store.refresh();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("recovers once the source does", async () => {
    let fail = true;
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => {
        if (fail) throw new Error("down");
        return rows("alpha");
      }),
      declared,
      0,
    );

    expect((await store.get()).unavailable).toBe(true);
    fail = false;
    expect((await store.refresh()).unavailable).toBe(false);
  });
});

describe("peek", () => {
  test("does not trigger a load", async () => {
    const source = new ScriptedSource(async () => rows("alpha"));
    const store = new FeatureFlagStore(source, declared, 1000);

    expect(store.peek()).toBe(null);
    expect(source.calls).toBe(0);

    await store.get();
    expect(store.peek()!.flags.size).toBe(1);
  });
});
