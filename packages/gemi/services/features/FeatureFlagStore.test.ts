import { describe, expect, test, vi } from "vitest";
import { defineFeature } from "./defineFeature";
import { FeatureFlagStore, FeatureReloadError } from "./FeatureFlagStore";
import { FeatureFlagSource } from "./sources/FeatureFlagSource";

const declared = {
  alpha: defineFeature(),
  beta: defineFeature(),
};

class ScriptedSource extends FeatureFlagSource {
  calls = 0;
  constructor(private readonly script: () => Promise<Record<string, unknown>[]>) {
    super();
  }
  async load() {
    this.calls++;
    return await this.script();
  }
}

const rows = (...keys: string[]) => keys.map((key) => ({ key, active: true }));

describe("loading", () => {
  test("reads switches for declared keys", async () => {
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => rows("alpha")),
      declared,
      1000,
    );
    const snapshot = await store.get();

    expect(snapshot.unavailable).toBe(false);
    expect(snapshot.active.get("alpha")).toBe(true);
  });

  test("anything other than true is off", async () => {
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => [
        { key: "alpha", active: false },
        { key: "beta", active: "yes" },
      ]),
      declared,
      1000,
    );
    const snapshot = await store.get();

    expect(snapshot.active.get("alpha")).toBe(false);
    // A row is the one part of this system nobody reviews, so a non-boolean is
    // coerced to off rather than trusted for its truthiness.
    expect(snapshot.active.get("beta")).toBe(false);
  });

  test("a row for an undeclared feature is ignored with a warning", async () => {
    const warn = vi.fn();
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => rows("alpha", "ghost")),
      declared,
      1000,
      warn,
    );
    const snapshot = await store.get();

    expect([...snapshot.active.keys()]).toEqual(["alpha"]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/"ghost"/);
  });

  test("a row with no key is ignored with a warning", async () => {
    const warn = vi.fn();
    const store = new FeatureFlagStore(
      new ScriptedSource(async () => [{ active: true }]),
      declared,
      1000,
      warn,
    );

    expect((await store.get()).active.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  test("an empty table is a normal, available state", async () => {
    const store = new FeatureFlagStore(new ScriptedSource(async () => []), declared, 1000);
    const snapshot = await store.get();

    expect(snapshot.unavailable).toBe(false);
    expect(snapshot.active.size).toBe(0);
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
    expect([...stale.active.keys()]).toEqual(["alpha"]);

    // The background refresh lands, and the next read sees it.
    await store.refresh();
    expect([...(await store.get()).active.keys()].sort()).toEqual(["alpha", "beta"]);
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
    expect(snapshot.active.size).toBe(0);
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

    // An outage must not read as "every feature switched itself off".
    expect(after.unavailable).toBe(false);
    expect([...after.active.keys()]).toEqual(["alpha"]);
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

describe("invalidate", () => {
  test("reloads inside the TTL, which get() would not", async () => {
    let live = "alpha";
    const source = new ScriptedSource(async () => rows(live));
    const store = new FeatureFlagStore(source, declared, 60_000);

    await store.get();
    live = "beta";

    await store.get();
    expect(source.calls).toBe(1);

    const snapshot = await store.invalidate();
    expect(snapshot.active.get("beta")).toBe(true);
    expect(source.calls).toBe(2);
  });

  test("never settles on a load that started before it was called", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = "alpha";
    let first = true;
    const source = new ScriptedSource(async () => {
      // Read at entry, so the first load is a query that hit the table before
      // the write below and returns long after it.
      const seen = live;
      if (first) {
        first = false;
        await gate;
      }
      return rows(seen);
    });
    const store = new FeatureFlagStore(source, declared, 60_000);

    // In flight, and it read the table before the write below.
    const inflight = store.refresh();
    live = "beta";
    const invalidated = store.invalidate();
    release();

    // `refresh()` joins the in-flight load and reports the pre-write table.
    expect((await inflight).active.get("beta")).toBe(undefined);
    // `invalidate()` waits it out and issues its own query, so the caller sees
    // the write it just made.
    expect((await invalidated).active.get("beta")).toBe(true);
    expect(source.calls).toBe(2);
  });

  test("a failed reload throws instead of returning the pre-write snapshot", async () => {
    let fail = false;
    const source = new ScriptedSource(async () => {
      if (fail) throw new Error("down");
      return rows("alpha");
    });
    const store = new FeatureFlagStore(source, declared, 60_000, () => {});

    await store.get();
    fail = true;

    // `load()` swallows, so without the generation check this resolves with the
    // kept snapshot and the caller cannot tell that their reload never happened.
    await expect(store.invalidate()).rejects.toThrow(FeatureReloadError);

    // The switches themselves are untouched: an outage still must not read as
    // "every feature switched itself off".
    expect(store.peek()!.active.get("alpha")).toBe(true);
    expect(store.peek()!.unavailable).toBe(false);
  });

  test("a failed reload does not pin the stale snapshot for a further TTL", async () => {
    let fail = false;
    const source = new ScriptedSource(async () => {
      if (fail) throw new Error("down");
      return rows("alpha");
    });
    const store = new FeatureFlagStore(source, declared, 0, () => {});

    await store.get();
    const loadedAt = store.peek()!.loadedAt;

    fail = true;
    await expect(store.invalidate()).rejects.toThrow(FeatureReloadError);

    // `loadedAt` used to be moved forward on failure, which made these switches
    // claim to be freshly loaded and bought the failure a whole extra TTL of
    // staleness — strictly worse than never having called `invalidate()`.
    expect(store.peek()!.loadedAt).toBe(loadedAt);
  });

  test("does not join a load that succeeded before it was called", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = "alpha";
    let first = true;
    const source = new ScriptedSource(async () => {
      const seen = live;
      if (first) {
        first = false;
        await gate;
      }
      return rows(seen);
    });
    const store = new FeatureFlagStore(source, declared, 60_000);

    const inflight = store.refresh();
    live = "beta";
    const invalidated = store.invalidate();
    release();
    await inflight;

    // The in-flight load succeeds and bumps the generation. That success is not
    // this call's, so it must not be mistaken for one — the generation is read
    // after the wait, not before.
    await expect(invalidated).resolves.toBeTruthy();
    expect((await invalidated).active.get("beta")).toBe(true);
  });
});

describe("peek", () => {
  test("does not trigger a load", async () => {
    const source = new ScriptedSource(async () => rows("alpha"));
    const store = new FeatureFlagStore(source, declared, 1000);

    expect(store.peek()).toBe(null);
    expect(source.calls).toBe(0);

    await store.get();
    expect(store.peek()!.active.size).toBe(1);
  });
});
