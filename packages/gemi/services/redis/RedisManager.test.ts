import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RedisManager } from "./RedisManager";

const bun = globalThis.Bun as any;
const RealRedisClient = bun.RedisClient;

afterEach(() => {
  bun.RedisClient = RealRedisClient;
});

/** Replaces `Bun.RedisClient` and counts constructions. */
function countingClient() {
  const built: { url?: string; options?: unknown }[] = [];
  bun.RedisClient = class {
    constructor(url?: string, options?: unknown) {
      built.push({ url, options });
    }
  };
  return built;
}

describe("RedisManager", () => {
  test("builds no client until one is asked for", () => {
    // The point of #403: the *import* of Bun's Redis client used to be eager,
    // and the construction with it. `RedisServiceProvider` binds this as a
    // singleton the container resolves whenever anything touches the config,
    // so an app that never issues a command must not build a client either.
    const built = countingClient();

    const manager = new RedisManager({ url: "redis://example:6379" });
    expect(built).toHaveLength(0);

    void manager.client;
    expect(built).toEqual([{ url: "redis://example:6379", options: undefined }]);
  });

  test("memoises the client across accesses", () => {
    const built = countingClient();
    const manager = new RedisManager();

    expect(manager.client).toBe(manager.client);
    expect(built).toHaveLength(1);
  });

  test("takes an injected client, the way the storage drivers do", () => {
    // `client` was a plain public property before it was an accessor, and
    // overwriting it is how this repo fakes a driver's client — see
    // `S3Driver.test.ts`. A getter with no setter would have turned that into
    // `TypeError: Attempted to assign to readonly property`.
    const built = countingClient();
    const fake = { get: async () => "value" } as any;

    const manager = new RedisManager();
    manager.client = fake;

    expect(manager.client).toBe(fake);
    expect(built).toHaveLength(0);
  });

  test("explains itself off Bun rather than throwing on undefined", () => {
    // What a browser-targeted runner, or any non-Bun runtime, now hits: the
    // module still *loads* there — that is the fix — so the failure has to
    // arrive with an explanation when the client is finally asked for.
    // Assigned rather than deleted: the property is writable but not
    // configurable, and `undefined` is what a runtime without it looks like.
    bun.RedisClient = undefined;

    expect(() => new RedisManager().client).toThrow(/Bun's built-in Redis client/);
  });

  // What the provider's `shutdown()` calls, so a `gemi dev` reload does not
  // leave the replaced application's connection open (#652).
  test("close() closes a client that was built, and builds none to close", () => {
    const closed: number[] = [];
    let n = 0;
    bun.RedisClient = class {
      id = ++n;
      close() {
        closed.push(this.id);
      }
    };

    new RedisManager().close();
    expect(n).toBe(0);

    const manager = new RedisManager();
    void manager.client;
    manager.close();
    expect(closed).toEqual([1]);

    // A later access builds a fresh client rather than handing back the closed one.
    expect((manager.client as any).id).toBe(2);
  });

  // #982: once Bun's client gives up on a connection it never connects again
  // (and calling its `connect()` again can hang), so the manager replaces a
  // client that is down, spaced out.
  describe("replacing a client that gave up", () => {
    /** Clients whose `connect()` succeeds, fails or hangs as the test says. */
    function controllableClients() {
      const state = {
        mode: "down" as "up" | "down" | "hang",
        built: [] as any[],
      };
      bun.RedisClient = class {
        connected = false;
        closed = false;
        constructor() {
          state.built.push(this);
        }
        connect() {
          if (state.mode === "hang") return new Promise(() => {});
          if (state.mode === "down") return Promise.reject(new Error("Connection closed"));
          this.connected = true;
          return Promise.resolve();
        }
        close() {
          this.closed = true;
          this.connected = false;
        }
      };
      return state;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("starts connecting when it builds the client, and keeps a connected one", async () => {
      const state = controllableClients();
      state.mode = "up";
      const manager = new RedisManager();
      const client = manager.client;
      await vi.advanceTimersByTimeAsync(0);

      expect(client.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.client).toBe(client);
      expect(state.built).toHaveLength(1);
    });

    test("leaves a client alone while its connect is pending", async () => {
      const state = controllableClients();
      state.mode = "hang";
      const manager = new RedisManager({ options: { connectionTimeout: 1_000 } });
      const client = manager.client;

      await vi.advanceTimersByTimeAsync(5_999);
      expect(manager.client).toBe(client);

      // Past its own timeout plus a grace period it counts as failed.
      await vi.advanceTimersByTimeAsync(1);
      void manager.client; // seen down
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.client).not.toBe(client);
      expect((client as any).closed).toBe(true);
    });

    test("replaces a client that is down, closing it, with a growing wait", async () => {
      const state = controllableClients();
      const manager = new RedisManager();
      void manager.client;
      await vi.advanceTimersByTimeAsync(0);
      expect(state.built).toHaveLength(1);

      // Seen down now; replaced 0.5 s later, then after 1 s, 2 s, ...
      for (const wait of [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
        void manager.client;
        const before = state.built.length;
        await vi.advanceTimersByTimeAsync(wait - 1);
        void manager.client;
        expect(state.built).toHaveLength(before);
        await vi.advanceTimersByTimeAsync(1);
        void manager.client;
        expect(state.built).toHaveLength(before + 1);
        expect(state.built[before - 1].closed).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
      }

      // Redis is back: the next replacement connects and is kept, and the
      // wait starts over at 0.5 s.
      state.mode = "up";
      void manager.client;
      await vi.advanceTimersByTimeAsync(10_000);
      const client = manager.client;
      await vi.advanceTimersByTimeAsync(0);
      expect(client.connected).toBe(true);
      expect(manager.client).toBe(client);

      (client as any).connected = false;
      void manager.client;
      await vi.advanceTimersByTimeAsync(500);
      expect(manager.client).not.toBe(client);
    });

    test("a short drop that Bun's own reconnect covers costs nothing", async () => {
      const state = controllableClients();
      state.mode = "up";
      const manager = new RedisManager();
      const client = manager.client;
      await vi.advanceTimersByTimeAsync(0);

      (client as any).connected = false;
      void manager.client;
      await vi.advanceTimersByTimeAsync(300);
      (client as any).connected = true;
      void manager.client;
      await vi.advanceTimersByTimeAsync(300);

      expect(manager.client).toBe(client);
      expect(state.built).toHaveLength(1);
    });

    test("leaves a stand-in without connect() alone", () => {
      const manager = new RedisManager();
      const fake = { connected: false } as any;
      manager.client = fake;
      vi.advanceTimersByTime(60_000);
      expect(manager.client).toBe(fake);
    });
  });
});
