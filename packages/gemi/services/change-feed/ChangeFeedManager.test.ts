import { afterEach, describe, expect, test, vi } from "vitest";

import { withTransaction } from "../../orm/context";
import type { ChangeFeedDriver, ChangeFeedEvent } from "./ChangeFeedDriver";
import { ChangeFeedFullError, ChangeFeedManager } from "./ChangeFeedManager";
import { decodeCursor, encodeCursor } from "./cursor";
import { MemoryChangeFeedDriver } from "./MemoryChangeFeedDriver";

const managers: ChangeFeedManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  vi.useRealTimers();
});

function feed(config: ConstructorParameters<typeof ChangeFeedManager>[0] = {}) {
  const manager = new ChangeFeedManager(config);
  managers.push(manager);
  return manager;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The next event, or "none" when nothing arrives within a few ticks. */
async function nextOrNone(iterator: AsyncIterator<ChangeFeedEvent>) {
  return Promise.race([
    iterator.next().then((result) => (result.done ? "done" : result.value)),
    new Promise((resolve) => setTimeout(() => resolve("none"), 30)),
  ]);
}

/** The withTransaction fake `orm/context.test.ts` uses: no database needed. */
function fakePool() {
  const handle: any = {
    savepoint(fn: (sp: any) => Promise<unknown>) {
      return Promise.resolve().then(() => fn(handle));
    },
  };
  return {
    begin(fn: (tx: any) => Promise<unknown>) {
      return Promise.resolve().then(() => fn(handle));
    },
  } as any;
}

describe("cursor", () => {
  test("round-trips channels with any characters", () => {
    const positions = new Map([
      ["site:42", 17],
      ["a b&c=d", 0],
    ]);
    const cursor = encodeCursor(positions);
    expect(cursor).toBe("site%3A42=17&a+b%26c%3Dd=0");
    expect(decodeCursor(cursor)).toEqual(positions);
  });

  test("drops what is not a whole seq", () => {
    expect(decodeCursor("a=1&b=-1&c=x&d=&e=1.5")).toEqual(new Map([["a", 1]]));
    expect(decodeCursor(null)).toEqual(new Map());
  });
});

describe("ChangeFeedManager", () => {
  test("a subscription without a cursor starts at the head", async () => {
    const changes = feed();
    await changes.publish("site:1", "before");
    const subscription = changes.subscribe("site:1");
    await subscription.ready();
    expect(subscription.cursor).toBe("site%3A1=1");

    await changes.publish("site:1", "after");
    expect(await nextOrNone(subscription)).toEqual({
      type: "change",
      channel: "site:1",
      seq: 2,
      data: "after",
    });
    expect(subscription.cursor).toBe("site%3A1=2");
  });

  test("a subscription resumes from a cursor, and wakes for publishes while it waits", async () => {
    const changes = feed();
    for (const n of [1, 2, 3]) await changes.publish("a", n);
    const subscription = changes.subscribe(["a", "b"], { cursor: "a=1" });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const event of subscription) {
        seen.push([event.channel, event.seq]);
        if (seen.length === 4) break;
      }
    })();
    await settle();
    expect(seen).toEqual([
      ["a", 2],
      ["a", 3],
    ]);
    await changes.publish("b", "x");
    await changes.publish("a", 4);
    await reading;
    expect(seen).toEqual([
      ["a", 2],
      ["a", 3],
      ["b", 1],
      ["a", 4],
    ]);
    // Breaking out of `for await` ends it.
    expect(subscription.isClosed).toBe(true);
    expect(changes.subscriptions).toBe(0);
  });

  test("the cursor moves one event at a time, not one read-ahead batch at a time", async () => {
    const changes = feed({ batchSize: 10 });
    for (let n = 1; n <= 5; n++) await changes.publish("a", n);
    const subscription = changes.subscribe("a", { cursor: { a: 0 } });
    await subscription.next();
    expect(subscription.cursor).toBe("a=1");
    await subscription.next();
    expect(subscription.cursor).toBe("a=2");
  });

  test("reads the log in batches until it is caught up", async () => {
    const changes = feed({ batchSize: 2 });
    for (let n = 1; n <= 5; n++) await changes.publish("a", n);
    const read = vi.spyOn(changes.driver, "read");
    const subscription = changes.subscribe("a", { cursor: "a=0" });
    const seqs = [];
    for (let i = 0; i < 5; i++) seqs.push((await subscription.next()).value!.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(read.mock.calls.map(([, after]) => after)).toEqual([0, 2, 4]);
  });

  test("a cursor older than the log keeps resets the channel", async () => {
    const changes = feed({ driver: new MemoryChangeFeedDriver({ retain: 2 }) });
    for (let n = 1; n <= 5; n++) await changes.publish("a", n);
    const subscription = changes.subscribe("a", { cursor: "a=1" });
    expect((await subscription.next()).value).toEqual({ type: "reset", channel: "a", seq: 5 });
    expect(subscription.cursor).toBe("a=5");
    await changes.publish("a", 6);
    expect((await subscription.next()).value).toMatchObject({ type: "change", seq: 6 });
  });

  test("a cursor ahead of the head (a reset store) resets the channel", async () => {
    const changes = feed();
    await changes.publish("a", 1);
    const subscription = changes.subscribe("a", { cursor: "a=40" });
    expect((await subscription.next()).value).toEqual({ type: "reset", channel: "a", seq: 1 });
  });

  test("ignores cursor positions for channels it does not follow", async () => {
    const changes = feed();
    const subscription = changes.subscribe("a", { cursor: "other=3&a=0" });
    await subscription.ready();
    expect(subscription.cursor).toBe("a=0");
  });

  test("an abort signal ends a waiting subscription", async () => {
    const changes = feed();
    const controller = new AbortController();
    const subscription = changes.subscribe("a", { signal: controller.signal });
    const next = subscription.next();
    await settle();
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(changes.subscriptions).toBe(0);
  });

  test("refuses a subscription past maxSubscriptions", () => {
    const changes = feed({ maxSubscriptions: 2 });
    changes.subscribe("a");
    const second = changes.subscribe("b");
    expect(() => changes.subscribe("c")).toThrow(ChangeFeedFullError);
    second.close();
    expect(() => changes.subscribe("c")).not.toThrow();
  });

  test("refuses empty and over-long channels", async () => {
    const changes = feed();
    await expect(changes.publish("", 1)).rejects.toThrow(/1 to 255 characters/);
    await expect(changes.publish("x".repeat(256), 1)).rejects.toThrow(/1 to 255 characters/);
    expect(() => changes.subscribe([])).toThrow(/at least one channel/);
  });

  test("close() ends every subscription", async () => {
    const changes = feed();
    const subscription = changes.subscribe("a");
    const next = subscription.next();
    await changes.close();
    expect(await next).toEqual({ done: true, value: undefined });
  });

  test("a publish inside a transaction is held until the commit, and dropped on rollback", async () => {
    const changes = feed();
    const subscription = changes.subscribe("a");
    await subscription.ready();

    await withTransaction(fakePool(), async () => {
      expect(await changes.publish("a", "committed")).toBeNull();
      expect(await changes.head("a")).toBe(0);
    });
    await settle();
    expect(await changes.head("a")).toBe(1);
    expect(await nextOrNone(subscription)).toMatchObject({ seq: 1, data: "committed" });

    await expect(
      withTransaction(fakePool(), async () => {
        await changes.publish("a", "rolled back");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await settle();
    expect(await changes.head("a")).toBe(1);
    expect(await nextOrNone(subscription)).toBe("none");
  });

  test("polls the heads of followed channels, for publishes it was not told of", async () => {
    vi.useFakeTimers();
    const driver = new MemoryChangeFeedDriver();
    const changes = feed({ driver, pollInterval: 1_000 });
    const subscription = changes.subscribe("a");
    await subscription.ready();
    const next = subscription.next();
    // Another process's publish: straight into the shared store.
    await driver.publish("a", "elsewhere");
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await next).value).toMatchObject({ seq: 1, data: "elsewhere" });
  });

  test("retries listening with backoff, and re-reads once it listens", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const memory = new MemoryChangeFeedDriver();
    let attempts = 0;
    const driver: ChangeFeedDriver = {
      publish: (channel, data) => memory.publish(channel, data),
      heads: (channels) => memory.heads(channels),
      read: (channel, after, limit) => memory.read(channel, after, limit),
      listen: async () => {
        attempts++;
        if (attempts < 3) throw new Error("connection refused");
        return { close: async () => {} };
      },
    };
    const changes = feed({ driver, pollInterval: 60_000 });
    const subscription = changes.subscribe("a");
    await subscription.ready();
    const next = subscription.next();
    await memory.publish("a", "missed while down");
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(3);
    expect(changes.isListening).toBe(true);
    expect((await next).value).toMatchObject({ seq: 1, data: "missed while down" });
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
