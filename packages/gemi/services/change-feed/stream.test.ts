import { afterEach, describe, expect, test, vi } from "vitest";

import { markShuttingDown, resetShuttingDown } from "../../server/shutdown";
import { ChangeFeedManager } from "./ChangeFeedManager";

const managers: ChangeFeedManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  resetShuttingDown();
});

function feed(config: ConstructorParameters<typeof ChangeFeedManager>[0] = {}) {
  const manager = new ChangeFeedManager(config);
  managers.push(manager);
  return manager;
}

/** Reads SSE events off a response body, one `next()` at a time. */
function events(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<{ id?: string; data?: unknown; comment?: string } | null> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith(":")) return { comment: block.slice(1).trim() };
          const event: { id?: string; data?: unknown } = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) event.id = line.slice(4);
            if (line.startsWith("data: ")) event.data = JSON.parse(line.slice(6));
          }
          return event;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

const request = (headers: Record<string, string> = {}, url = "http://app.test/api/changes") =>
  new Request(url, { headers });

describe("ChangeFeed.stream", () => {
  test("sends ready with the cursor, then each change with the cursor after it", async () => {
    const changes = feed();
    await changes.publish("site:1", "old");
    const response = changes.stream(request(), "site:1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const stream = events(response);

    expect(await stream.next()).toEqual({ id: "site%3A1=1", data: { type: "ready" } });
    await changes.publish("site:1", { pages: ["/"] });
    expect(await stream.next()).toEqual({
      id: "site%3A1=2",
      data: { type: "change", channel: "site:1", seq: 2, data: { pages: ["/"] } },
    });
    await stream.cancel();
  });

  test("resumes from Last-Event-ID, then from the cursor search parameter", async () => {
    const changes = feed();
    for (const n of [1, 2, 3]) await changes.publish("a", n);

    const fromHeader = events(changes.stream(request({ "Last-Event-ID": "a=1" }), "a"));
    expect(await fromHeader.next()).toEqual({ id: "a=1", data: { type: "ready" } });
    expect((await fromHeader.next())!.data).toMatchObject({ seq: 2 });
    await fromHeader.cancel();

    const fromSearch = events(
      changes.stream(request({}, "http://app.test/api/changes?cursor=a%3D2"), "a"),
    );
    await fromSearch.next();
    expect((await fromSearch.next())!.data).toMatchObject({ seq: 3 });
    await fromSearch.cancel();
  });

  test("answers 503 with Retry-After when the feed is full", async () => {
    const changes = feed({ maxSubscriptions: 1 });
    changes.subscribe("a");
    const response = changes.stream(request(), "a", { retryAfter: 9 });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("9");
  });

  test("ends the subscription when the client goes away", async () => {
    const changes = feed();
    const controller = new AbortController();
    const stream = events(
      changes.stream(new Request("http://app.test/", { signal: controller.signal }), "a"),
    );
    await stream.next();
    expect(changes.subscriptions).toBe(1);
    controller.abort();
    expect(await stream.next()).toBeNull();
    expect(changes.subscriptions).toBe(0);
  });

  test("ends the subscription when the reader cancels", async () => {
    const changes = feed();
    const stream = events(changes.stream(request(), "a"));
    await stream.next();
    await stream.cancel();
    expect(changes.subscriptions).toBe(0);
  });

  test("writes keepalives, and ends once the server is shutting down", async () => {
    vi.useFakeTimers();
    try {
      const changes = feed({ keepaliveInterval: 1_000 });
      const stream = events(changes.stream(request(), "a"));
      await stream.next();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await stream.next()).toEqual({ comment: "keepalive" });
      markShuttingDown();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await stream.next()).toBeNull();
      expect(changes.subscriptions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
