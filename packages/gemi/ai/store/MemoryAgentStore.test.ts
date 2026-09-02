import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../types";
import { MemoryAgentStore } from "./MemoryAgentStore";

const message = (id: string, role: AgentMessage["role"], text: string): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
});

describe("MemoryAgentStore", () => {
  test("creates a thread that starts empty", async () => {
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({ userId: 1 });
    expect(threadId).toMatch(/[0-9a-f-]{36}/);
    expect(await store.loadThread(threadId)).toEqual([]);
  });

  test("appends and reads back in order", async () => {
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);
    await store.appendMessages(threadId, [message("2", "assistant", "hello")]);

    expect((await store.loadThread(threadId)).map((m) => m.id)).toEqual(["1", "2"]);
  });

  test("hands out a copy, so a caller cannot edit history in place", async () => {
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);

    (await store.loadThread(threadId)).pop();

    expect(await store.loadThread(threadId)).toHaveLength(1);
  });

  test("reads an unknown thread as empty rather than throwing", async () => {
    const store = new MemoryAgentStore();
    expect(await store.loadThread("never-existed")).toEqual([]);
  });

  test("creates a thread on append, so a client-owned id cannot lose a turn", async () => {
    const store = new MemoryAgentStore();
    await store.appendMessages("client-chose-this", [message("1", "user", "hi")]);
    expect((await store.loadThread("client-chose-this")).map((m) => m.id)).toEqual(["1"]);
  });

  test("drops a thread nobody has touched for ttlMs", async () => {
    const store = new MemoryAgentStore({ ttlMs: 10 });
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);

    // Sweeping is throttled to once a minute, so the test has to ask from far
    // enough in the future to get past the throttle as well as the ttl.
    store.sweep(Date.now() + 90_000);

    expect(store.size).toBe(0);
    expect(await store.loadThread(threadId)).toEqual([]);
  });

  test("keeps a thread whose ttl has not run out", async () => {
    const store = new MemoryAgentStore({ ttlMs: 120_000 });
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);

    store.sweep(Date.now() + 90_000);

    expect(store.size).toBe(1);
  });
});
