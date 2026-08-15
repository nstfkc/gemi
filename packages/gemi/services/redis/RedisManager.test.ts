import { afterEach, describe, expect, test } from "vitest";

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
});
