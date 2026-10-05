/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// The manager's database side imports Bun's SQL, which the jsdom environment
// cannot resolve. Nothing here uses a database or a transaction.
vi.mock("../database/DatabaseManager", () => ({ DatabaseManager: class {} }));
vi.mock("../services/change-feed/DatabaseChangeFeedDriver", () => ({
  DatabaseChangeFeedDriver: class {},
}));
vi.mock("../orm/context", () => ({
  currentTransaction: () => undefined,
  afterCommit: async (callback: () => unknown) => void (await callback()),
}));

import { ChangeFeedManager } from "../services/change-feed/ChangeFeedManager";
import { readEvents, useSubscription } from "./useSubscription";

/**
 * The hook against the real `ChangeFeed.stream`: `fetch` is stubbed to hand
 * the request to a manager, the way a route would, so what is tested is the
 * pair, cursor and all.
 */

let manager: ChangeFeedManager;
const requests: Array<{ url: string; lastEventId: string | null }> = [];

function serve(respond?: (request: Request) => Response | undefined) {
  manager = new ChangeFeedManager();
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const request = new Request(`http://app.test${url}`, init);
      requests.push({ url, lastEventId: request.headers.get("Last-Event-ID") });
      return respond?.(request) ?? manager.stream(request, "site:1");
    }),
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await manager?.close();
});

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

type Seen = { changes: unknown[]; resets: unknown[]; status?: string; cursor?: string | null };

function Follow(props: { seen: Seen; cursor?: string; enabled?: boolean }) {
  const { status, cursor } = useSubscription(
    "/sites/:siteId/changes" as never,
    { params: { siteId: "s1" } } as never,
    {
      cursor: props.cursor,
      enabled: props.enabled,
      onChange: (event) => props.seen.changes.push([event.seq, event.data]),
      onReset: (event) => props.seen.resets.push(event.seq),
    },
  );
  props.seen.status = status;
  props.seen.cursor = cursor;
  return null;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useSubscription", () => {
  test("connects to the route and applies each change in order", async () => {
    serve();
    const seen: Seen = { changes: [], resets: [] };
    render(<Follow seen={seen} />);
    await tick();
    expect(requests[0]).toEqual({ url: "/api/sites/s1/changes", lastEventId: null });
    expect(seen.status).toBe("open");

    await act(async () => {
      await manager.publish("site:1", { pages: ["/"] });
      await manager.publish("site:1", { pages: ["/about"] });
    });
    await tick();
    expect(seen.changes).toEqual([
      [1, { pages: ["/"] }],
      [2, { pages: ["/about"] }],
    ]);
    expect(seen.cursor).toBe("site%3A1=2");
  });

  test("starts from the cursor the view was rendered with", async () => {
    serve();
    await manager.publish("site:1", "rendered");
    const cursor = await manager.cursor("site:1");
    await manager.publish("site:1", "between render and connect");
    const seen: Seen = { changes: [], resets: [] };
    render(<Follow seen={seen} cursor={cursor} />);
    await tick();
    expect(requests[0]!.lastEventId).toBe("site%3A1=1");
    expect(seen.changes).toEqual([[2, "between render and connect"]]);
  });

  test("reconnects after the stream ends, resuming from the last event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve();
    const seen: Seen = { changes: [], resets: [] };
    render(<Follow seen={seen} />);
    await tick();
    await act(async () => {
      await manager.publish("site:1", 1);
    });
    await tick();

    // The server goes away: every stream ends.
    await act(async () => {
      for (const subscription of (manager as any).all) subscription.close();
    });
    await tick();
    await act(async () => {
      await manager.publish("site:1", 2);
    });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await tick();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.lastEventId).toBe("site%3A1=1");
    expect(seen.changes).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test("stops on a refusal it cannot retry its way out of", async () => {
    serve(() => new Response("{}", { status: 403 }));
    const seen: Seen = { changes: [], resets: [] };
    render(<Follow seen={seen} />);
    await tick();
    await tick();
    expect(seen.status).toBe("closed");
    expect(requests).toHaveLength(1);
  });

  test("waits out a 503's Retry-After", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let full = true;
    serve(() => (full ? new Response("{}", { status: 503, headers: { "Retry-After": "7" } }) : undefined));
    const seen: Seen = { changes: [], resets: [] };
    render(<Follow seen={seen} />);
    await tick();
    expect(requests).toHaveLength(1);
    full = false;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(requests).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await tick();
    expect(requests).toHaveLength(2);
    expect(seen.status).toBe("open");
  });

  test("disconnects while the tab is hidden, and catches up once it is shown", async () => {
    serve();
    const seen: Seen = { changes: [], resets: [] };
    render(<Follow seen={seen} />);
    await tick();
    act(() => setVisibility("hidden"));
    await tick();
    expect(seen.status).toBe("paused");
    expect(manager.subscriptions).toBe(0);

    await act(async () => {
      await manager.publish("site:1", "while hidden");
    });
    act(() => setVisibility("visible"));
    await tick();
    expect(requests).toHaveLength(2);
    expect(seen.changes).toEqual([[1, "while hidden"]]);
  });

  test("passes a reset on", async () => {
    serve();
    const seen: Seen = { changes: [], resets: [] };
    // A cursor ahead of the head: the store was reset.
    render(<Follow seen={seen} cursor="site%3A1=9" />);
    await tick();
    expect(seen.resets).toEqual([0]);
  });

  test("enabled: false never connects, and unmounting closes the stream", async () => {
    serve();
    const seen: Seen = { changes: [], resets: [] };
    const view = render(<Follow seen={seen} enabled={false} />);
    await tick();
    expect(requests).toHaveLength(0);
    view.rerender(<Follow seen={seen} />);
    await tick();
    expect(manager.subscriptions).toBe(1);
    view.unmount();
    await tick();
    expect(manager.subscriptions).toBe(0);
  });
});

describe("readEvents", () => {
  test("joins events split across chunks and skips comments and non-JSON", async () => {
    const chunks = [': keepalive\n\nid: a=1\ndata: {"type":', '"ready"}\n\ndata: nope\n\n', "id: a=2\r\ndata: {\"type\":\"reset\",\"channel\":\"a\",\"seq\":2}\r\n\r\n"];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readEvents(body)) events.push(event);
    expect(events).toEqual([
      { id: "a=1", message: { type: "ready" } },
      { id: "a=2", message: { type: "reset", channel: "a", seq: 2 } },
    ]);
  });
});
