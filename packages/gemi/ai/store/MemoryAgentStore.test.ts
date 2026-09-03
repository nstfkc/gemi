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

  test("replaces a message it already holds instead of holding it twice", async () => {
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [
      message("1", "user", "hi"),
      message("2", "assistant", "one sec"),
      message("3", "user", "ok"),
    ]);

    // What a turn that resolves a pending call reports: the earlier assistant
    // message again, under its own id, plus the new tail.
    await store.appendMessages(threadId, [
      message("2", "assistant", "done"),
      message("4", "assistant", "anything else?"),
    ]);

    const held = await store.loadThread(threadId);
    expect(held.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
    expect(held[1]!.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("hands out a copy, so a caller cannot edit history in place", async () => {
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);

    (await store.loadThread(threadId)).pop();

    expect(await store.loadThread(threadId)).toHaveLength(1);
  });

  test("answers null for a thread it does not have, which is not an empty one", async () => {
    const store = new MemoryAgentStore();
    // `[]` here was the bug: an expired or mistyped id read as a conversation
    // with nothing in it yet, and the controller ran the turn on that.
    expect(await store.loadThread("never-existed")).toBeNull();
  });

  test("refuses to append to a thread it does not have", async () => {
    const store = new MemoryAgentStore();
    await expect(
      store.appendMessages("never-existed", [message("1", "user", "hi")]),
    ).rejects.toThrow(/never-existed/);
    expect(store.size).toBe(0);
  });

  test("with client-owned ids, an id it has not seen is a conversation starting", async () => {
    // The one setup where unknown is not lost: the client minted the id, so
    // the first turn arrives before anything is stored under it.
    const store = new MemoryAgentStore({ clientOwnedIds: true });
    expect(await store.loadThread("client-chose-this")).toEqual([]);
    await store.appendMessages("client-chose-this", [message("1", "user", "hi")]);
    expect((await store.loadThread("client-chose-this"))!.map((m) => m.id)).toEqual(["1"]);
  });

  test("drops a thread nobody has touched for ttlMs", async () => {
    const store = new MemoryAgentStore({ ttlMs: 10 });
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);

    // Sweeping is throttled to once a minute, so the test has to ask from far
    // enough in the future to get past the throttle as well as the ttl.
    store.sweep(Date.now() + 90_000);

    expect(store.size).toBe(0);
    // Gone, not empty: the client holding this id has a history the store no
    // longer does, and has to be told.
    expect(await store.loadThread(threadId)).toBeNull();
  });

  test("keeps a thread whose ttl has not run out", async () => {
    const store = new MemoryAgentStore({ ttlMs: 120_000 });
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("1", "user", "hi")]);

    store.sweep(Date.now() + 90_000);

    expect(store.size).toBe(1);
  });
});
