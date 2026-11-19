import { afterEach, describe, expect, test, vi } from "vitest";

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

  test("stores messages as JSON, as a database store does (#1107)", async () => {
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    const at = new Date("2026-10-31T12:00:00.000Z");
    const written: AgentMessage = {
      id: "1",
      role: "assistant",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc_1",
          name: "grant",
          status: "ok",
          output: { grantedAt: at, note: undefined },
        },
      ],
      createdAt: at.toISOString(),
      finishReason: "stop",
    };
    await store.appendMessages(threadId, [written]);

    const [read] = (await store.loadThread(threadId))!;
    const part = read!.content[0] as { output: Record<string, unknown> };
    expect(part.output).toEqual({ grantedAt: "2026-10-31T12:00:00.000Z" });
    expect("note" in part.output).toBe(false);

    // A copy: editing what was written does not edit what is stored.
    (written.content[0] as { output: Record<string, unknown> }).output.grantedAt = "changed";
    const [again] = (await store.loadThread(threadId))!;
    expect((again!.content[0] as { output: Record<string, unknown> }).output.grantedAt).toBe(
      "2026-10-31T12:00:00.000Z",
    );
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

  test("forScope views keep their threads apart over one store (#1177)", async () => {
    const store = new MemoryAgentStore();
    const a = store.forScope("a");
    const b = store.forScope("b");
    const { threadId } = await a.createThread({});
    await a.appendMessages(threadId, [message("1", "user", "hi")]);

    expect(await b.loadThread(threadId)).toBeNull();
    await expect(b.appendMessages(threadId, [message("2", "user", "x")])).rejects.toThrow(/does not exist/);
    await b.removeMessages(threadId, ["1"]);
    await b.saveSummary(threadId, {
      cutMessageId: "1",
      text: "x",
      turns: 1,
      messages: 1,
      fingerprint: "f",
      createdAt: new Date(0).toISOString(),
    });
    b.delete(threadId);

    expect(await a.loadThread(threadId)).toHaveLength(1);
    expect(await a.loadSummaries(threadId)).toEqual([]);
    // The store itself sees every scope.
    expect(await store.loadThread(threadId)).toHaveLength(1);
    expect(() => store.forScope("")).toThrow(/non-empty/);
  });

  test("with client-owned ids, a view starts unknown ids in its scope but not another's", async () => {
    const store = new MemoryAgentStore({ clientOwnedIds: true });
    const a = store.forScope("a");
    const b = store.forScope("b");
    expect(await a.loadThread("t1")).toEqual([]);
    await a.appendMessages("t1", [message("1", "user", "hi")]);
    expect(await b.loadThread("t1")).toBeNull();
    await expect(b.appendMessages("t1", [message("2", "user", "x")])).rejects.toThrow(/does not exist/);
    expect(await a.loadThread("t1")).toHaveLength(1);
  });
});

describe("MemoryAgentStore expiring threads (#1312)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an expired thread is null at once, not only after the throttled sweep", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const store = new MemoryAgentStore({ ttlMs: 60_000 });
    const short = await store.createThread({ ttlMs: 1000 });
    const usual = await store.createThread({});
    vi.setSystemTime(1_000_000 + 1500);
    expect(await store.loadThread(short.threadId)).toBeNull();
    await expect(store.appendMessages(short.threadId, [message("1", "user", "x")])).rejects.toThrow(/does not exist/);
    expect(await store.loadThread(usual.threadId)).toEqual([]);
  });

  test("sliding by default; slidingTtl: false keeps the expiry fixed", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const sliding = new MemoryAgentStore({ ttlMs: 1000 });
    const fixed = new MemoryAgentStore({ ttlMs: 1000, slidingTtl: false });
    const a = await sliding.createThread({});
    const b = await fixed.createThread({});
    vi.setSystemTime(1_000_000 + 700);
    await sliding.appendMessages(a.threadId, [message("1", "user", "hi")]);
    await fixed.appendMessages(b.threadId, [message("1", "user", "hi")]);
    vi.setSystemTime(1_000_000 + 1400);
    expect(await sliding.loadThread(a.threadId)).toHaveLength(1);
    expect(await fixed.loadThread(b.threadId)).toBeNull();
  });

  test("expiresAt is fixed, and ttlMs: null keeps a thread", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const store = new MemoryAgentStore({ ttlMs: 1000 });
    const dated = await store.createThread({ expiresAt: new Date(1_000_000 + 5000) });
    const forever = await store.createThread({ ttlMs: null });
    vi.setSystemTime(1_000_000 + 4000);
    await store.appendMessages(dated.threadId, [message("1", "user", "hi")]);
    vi.setSystemTime(1_000_000 + 6000);
    expect(await store.loadThread(dated.threadId)).toBeNull();
    vi.setSystemTime(1_000_000 + 10 ** 10);
    expect(await store.loadThread(forever.threadId)).toEqual([]);
    await expect(store.createThread({ ttlMs: 0 })).rejects.toThrow(/positive/);
  });

  test("sweepExpired deletes now, up to limit, in a view's own scope", async () => {
    const store = new MemoryAgentStore({ ttlMs: 1000 });
    const a = store.forScope("a");
    for (let i = 0; i < 3; i++) await a.createThread({});
    const other = await store.forScope("b").createThread({});
    const later = Date.now() + 5000;
    expect(await a.sweepExpired({ now: later, limit: 2 })).toEqual({ deleted: 2 });
    expect(await a.sweepExpired({ now: later })).toEqual({ deleted: 1 });
    expect(store.size).toBe(1);
    expect(await store.forScope("b").loadThread(other.threadId)).toEqual([]);
    expect(await store.sweepExpired({ now: later + 10_000 })).toEqual({ deleted: 1 });
    expect(await store.sweepExpired()).toEqual({ deleted: 0 });
  });
});
