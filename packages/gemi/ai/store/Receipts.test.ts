import { describe, expect, test } from "vitest";
import type { ToolResultPart } from "../types";
import { MemoryReceiptStore, type ReceiptRedisClient, RedisReceiptStore } from "./Receipts";

const result: ToolResultPart = {
  type: "tool-result",
  toolCallId: "c1",
  name: "refundOrder",
  status: "ok",
  output: { refundId: "rf_1" },
};

/**
 * A Redis stand-in that runs the two scripts `RedisReceiptStore` sends and
 * plain `SET ... PX`, yielding between receiving a command and applying it so
 * concurrent callers interleave. Applying is synchronous, as in Redis.
 */
function fakeRedis() {
  const keys = new Map<string, { value: string; until: number }>();
  const live = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.until > Date.now()) return entry.value;
    keys.delete(key);
    return undefined;
  };
  const client: ReceiptRedisClient = {
    async send(command, args) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      if (command === "SET") {
        const [key, value, px, ms] = args;
        expect(px).toBe("PX");
        keys.set(key, { value, until: Date.now() + Number(ms) });
        return "OK";
      }
      if (command !== "EVAL") throw new Error(`unexpected command ${command}`);
      const [script, count, key, ...argv] = args;
      expect(count).toBe("1");
      if (script.includes("'NX'")) {
        const held = live(key);
        if (held === undefined) {
          keys.set(key, { value: argv[0], until: Date.now() + Number(argv[1]) });
          return "claimed";
        }
        return held;
      }
      if (script.includes("'DEL'")) {
        if (live(key) === argv[0]) {
          keys.delete(key);
          return 1;
        }
        return 0;
      }
      throw new Error("unexpected script");
    },
  };
  return { client, keys };
}

describe.each([
  ["MemoryReceiptStore", () => new MemoryReceiptStore()],
  ["RedisReceiptStore", () => new RedisReceiptStore({ client: fakeRedis().client })],
] as const)("%s", (_, make) => {
  const expiresAt = () => Date.now() + 60_000;

  test("claimed, then blocked while running, then replayed once recorded", async () => {
    const store = make();
    expect(await store.claim("e1", expiresAt())).toEqual({ status: "claimed" });
    expect(await store.claim("e1", expiresAt())).toEqual({ status: "blocked" });
    await store.complete("e1", result, expiresAt());
    expect(await store.claim("e1", expiresAt())).toEqual({ status: "replay", result });
    expect(await store.claim("e2", expiresAt())).toEqual({ status: "claimed" });
  });

  test("concurrent claims of one id: exactly one is claimed", async () => {
    const store = make();
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => store.claim("e1", expiresAt())),
    );
    expect(claims.filter((claim) => claim.status === "claimed")).toHaveLength(1);
  });

  test("release frees an unfinished claim but never a recorded result", async () => {
    const store = make();
    await store.claim("e1", expiresAt());
    await store.release("e1");
    expect(await store.claim("e1", expiresAt())).toEqual({ status: "claimed" });
    await store.complete("e1", result, expiresAt());
    await store.release("e1");
    expect(await store.claim("e1", expiresAt())).toEqual({ status: "replay", result });
  });

  test("a receipt past its expiry binds nothing", async () => {
    const store = make();
    await store.claim("e1", Date.now() + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.claim("e1", expiresAt())).toEqual({ status: "claimed" });
  });
});

test("MemoryReceiptStore hands out copies, so a caller cannot edit a replay", async () => {
  const store = new MemoryReceiptStore();
  const part = structuredClone(result) as any;
  await store.claim("e1", Date.now() + 60_000);
  await store.complete("e1", part, Date.now() + 60_000);
  part.output.refundId = "edited";
  const first = (await store.claim("e1", Date.now() + 60_000)) as any;
  first.result.output.refundId = "edited again";
  expect(await store.claim("e1", Date.now() + 60_000)).toEqual({ status: "replay", result });
});
