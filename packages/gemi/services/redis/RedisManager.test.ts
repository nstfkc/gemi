import { afterEach, describe, expect, test, vi } from "vitest";

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

  // #982: once Bun's client gives up on a connection it never connects again on
  // its own, so the manager calls `connect()` on it again, spaced out.
  describe("reviving a client that gave up", () => {
    /** A client whose `connect()` succeeds or fails as the test says. */
    function revivableClient() {
      const state = { up: false, connects: 0 };
      bun.RedisClient = class {
        connected = false;
        async connect() {
          state.connects += 1;
          if (!state.up) throw new Error("Connection closed");
          this.connected = true;
        }
      };
      return state;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    test("leaves a client that was just built alone", () => {
      const state = revivableClient();
      void new RedisManager().client;
      expect(state.connects).toBe(0);
    });

    test("reconnects a disconnected client on a later access, keeping the instance", async () => {
      const state = revivableClient();
      state.up = true;
      const manager = new RedisManager();
      const client = manager.client;

      expect(manager.client).toBe(client);
      await vi.waitFor(() => expect(client.connected).toBe(true));
      expect(state.connects).toBe(1);

      // Connected: nothing more to do.
      void manager.client;
      expect(state.connects).toBe(1);
    });

    test("runs one attempt at a time and backs off while Redis stays down", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const state = revivableClient();
      const manager = new RedisManager();
      void manager.client;

      // A burst of accesses shares one attempt.
      for (let i = 0; i < 5; i++) void manager.client;
      expect(state.connects).toBe(1);
      await vi.advanceTimersByTimeAsync(0);

      // Then waits 0.5 s, 1 s, 2 s ... between attempts.
      void manager.client;
      expect(state.connects).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      void manager.client;
      expect(state.connects).toBe(2);
      await vi.advanceTimersByTimeAsync(999);
      void manager.client;
      expect(state.connects).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      void manager.client;
      expect(state.connects).toBe(3);

      // Capped at 10 s.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        void manager.client;
      }
      const before = state.connects;
      await vi.advanceTimersByTimeAsync(10_000);
      void manager.client;
      expect(state.connects).toBe(before + 1);

      // Redis is back: the next attempt succeeds and the backoff starts over.
      state.up = true;
      await vi.advanceTimersByTimeAsync(10_000);
      const client = manager.client;
      await vi.advanceTimersByTimeAsync(0);
      expect(client.connected).toBe(true);
      (client as any).connected = false;
      void manager.client;
      expect(state.connects).toBe(before + 3);
    });

    test("leaves a fake client without connect() alone", () => {
      const manager = new RedisManager();
      const fake = { connected: false } as any;
      manager.client = fake;
      expect(() => manager.client).not.toThrow();
    });
  });
});
