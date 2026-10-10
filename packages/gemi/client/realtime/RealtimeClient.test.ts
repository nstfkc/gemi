/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BROADCAST_PROTOCOL } from "../../services/broadcast/protocol";
import {
  backoffDelay,
  MAX_LIMIT_RETRIES,
  RealtimeClient,
  type ChannelListener,
} from "./RealtimeClient";

class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    MockSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  // Server side.
  open(heartbeatMs = 25_000) {
    this.readyState = 1;
    this.onopen?.();
    this.receive({ op: "hello", socketId: "sock_1234567890", tag: "tag-me", heartbeatMs });
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  subs() {
    return this.sent.filter((f) => f.op === "sub");
  }
}

const latest = () => MockSocket.instances[MockSocket.instances.length - 1];

function client(random = () => 0.5) {
  return new RealtimeClient(
    { hiddenDisconnectMs: 60_000 },
    { WebSocket: MockSocket as any, url: "ws://test/__gemi/socket", random },
  );
}

function recorder() {
  const log: string[] = [];
  const listener: ChannelListener = {
    onEvent: (event, data) => log.push(`ev:${event}:${JSON.stringify(data)}`),
    onResync: () => log.push("resync"),
    onStatus: (status, code) => log.push(`status:${status}${code ? `:${code}` : ""}`),
  };
  return { log, listener };
}

let instance: RealtimeClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  MockSocket.instances = [];
});

afterEach(() => {
  instance?.dispose();
  instance = null;
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("RealtimeClient", () => {
  test("opens one socket lazily, with the gemi.v1 subprotocol, and multiplexes channels", () => {
    instance = client();
    expect(MockSocket.instances).toHaveLength(0);
    const a = recorder();
    const b = recorder();
    instance.subscribe("site.:siteId", { siteId: "abc" }, a.listener);
    instance.subscribe("user", {}, b.listener);
    expect(MockSocket.instances).toHaveLength(1);
    expect(latest().protocols).toEqual([BROADCAST_PROTOCOL]);
    latest().open();
    expect(latest().subs()).toEqual([
      { op: "sub", id: "1", ch: "site.:siteId", p: { siteId: "abc" } },
      { op: "sub", id: "2", ch: "user" },
    ]);
    expect(instance.socketId).toBe("sock_1234567890");
  });

  test("two listeners on one channel share a sub; the last release unsubscribes", () => {
    instance = client();
    const a = recorder();
    const b = recorder();
    const releaseA = instance.subscribe("site.:siteId", { siteId: "abc" }, a.listener);
    latest().open();
    const releaseB = instance.subscribe("site.:siteId", { siteId: "abc" }, b.listener);
    expect(latest().subs()).toHaveLength(1);
    latest().receive({ op: "subscribed", id: "1", t: "site.abc" });
    latest().receive({ op: "ev", t: "site.abc", ev: "changed", d: { n: 1 } });
    expect(a.log).toContain('ev:changed:{"n":1}');
    expect(b.log).toContain('ev:changed:{"n":1}');
    releaseA();
    expect(latest().sent.filter((f) => f.op === "unsub")).toHaveLength(0);
    releaseB();
    // It lingers in case a hook remounts, then goes.
    vi.advanceTimersByTime(1_499);
    expect(latest().sent.filter((f) => f.op === "unsub")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(latest().sent.filter((f) => f.op === "unsub")).toEqual([{ op: "unsub", id: "1" }]);
    // Closed after the idle delay, and not reopened.
    vi.advanceTimersByTime(5_000);
    expect(latest().closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  test("an ack opens the subscription and resyncs it; a gap resyncs again (coalesced)", () => {
    instance = client();
    const a = recorder();
    instance.subscribe("status", {}, a.listener);
    latest().open();
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    expect(a.log).toEqual(["status:closed", "status:connecting", "status:open", "resync"]);
    latest().receive({ op: "gap" });
    latest().receive({ op: "gap" });
    expect(a.log.filter((l) => l === "resync")).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(a.log.filter((l) => l === "resync")).toHaveLength(2);
  });

  test("an event that names this socket's tag in x is dropped", () => {
    instance = client();
    const a = recorder();
    instance.subscribe("status", {}, a.listener);
    latest().open();
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    latest().receive({ op: "ev", t: "status", ev: "mine", x: "tag-me" });
    latest().receive({ op: "ev", t: "status", ev: "theirs", x: "tag-other" });
    expect(a.log.filter((l) => l.startsWith("ev:"))).toEqual(["ev:theirs:undefined"]);
  });

  test("a drop reconnects with backoff, resubscribes, and resyncs on the new ack", () => {
    instance = client(() => 0.5);
    const a = recorder();
    instance.subscribe("status", {}, a.listener);
    latest().open();
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    latest().drop();
    expect(a.log.at(-1)).toBe("status:closed");
    expect(instance.socketId).toBeNull();
    vi.advanceTimersByTime(999);
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(2);
    latest().open();
    expect(latest().subs()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    expect(a.log.filter((l) => l === "resync")).toHaveLength(2);
  });

  test("reconnect() opens a new socket at once and resubscribes (after a sign-in)", () => {
    instance = client(() => 0.5);
    const a = recorder();
    instance.subscribe("user", {}, a.listener);
    latest().open();
    latest().receive({ op: "subscribed", id: "1", t: "user.1" });
    const first = latest();
    instance.reconnect();
    expect(first.closedWith).toBe(1000);
    expect(MockSocket.instances).toHaveLength(2);
    latest().open();
    expect(latest().subs()).toEqual([{ op: "sub", id: "1", ch: "user" }]);
  });

  test("reconnect() with nothing subscribed opens nothing", () => {
    instance = client();
    instance.reconnect();
    expect(MockSocket.instances).toHaveLength(0);
  });

  test("backoff is full jitter between 1 and 30 seconds", () => {
    expect(backoffDelay(0, 0)).toBe(1_000);
    expect(backoffDelay(0, 0.99)).toBe(1_000);
    expect(backoffDelay(3, 0.5)).toBe(4_000);
    expect(backoffDelay(20, 1)).toBe(30_000);
    expect(backoffDelay(20, 0)).toBe(1_000);
  });

  test("bye's retryAfter decides when to come back", () => {
    instance = client(() => 0);
    instance.subscribe("status", {}, recorder().listener);
    latest().open();
    latest().receive({ op: "bye", code: 1012, retryAfter: 3_000 });
    latest().drop(1012);
    vi.advanceTimersByTime(2_999);
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(2);
  });

  test("a revoked socket (4001) comes back promptly", () => {
    instance = client(() => 0.5);
    instance.subscribe("status", {}, recorder().listener);
    latest().open();
    latest().drop(4001);
    vi.advanceTimersByTime(250);
    expect(MockSocket.instances).toHaveLength(2);
  });

  test("going online retries at once", () => {
    instance = client(() => 0.99);
    instance.subscribe("status", {}, recorder().listener);
    latest().drop();
    window.dispatchEvent(new Event("online"));
    expect(MockSocket.instances).toHaveLength(2);
  });

  test("silence for two heartbeats closes and reconnects", () => {
    instance = client(() => 0);
    instance.subscribe("status", {}, recorder().listener);
    const first = latest();
    first.open();
    vi.advanceTimersByTime(25_000);
    expect(first.sent.filter((f) => f.op === "ping")).toHaveLength(1);
    first.receive({ op: "pong" });
    vi.advanceTimersByTime(49_999);
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.closedWith).toBeDefined();
    vi.advanceTimersByTime(1_000);
    expect(MockSocket.instances).toHaveLength(2);
  });

  test("a remount within the linger reuses the subscription: no unsub, no new sub", () => {
    instance = client();
    const a = recorder();
    const release = instance.subscribe("status", {}, a.listener);
    latest().open();
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    release();
    vi.advanceTimersByTime(500);
    const b = recorder();
    instance.subscribe("status", {}, b.listener);
    expect(b.log).toEqual(["status:open"]);
    vi.advanceTimersByTime(10_000);
    expect(latest().sent.filter((f) => f.op === "unsub")).toHaveLength(0);
    expect(latest().subs()).toHaveLength(1);
    latest().receive({ op: "ev", t: "status", ev: "deploy" });
    expect(b.log).toContain("ev:deploy:undefined");
  });

  test("rate_limited and error are retried on the same socket, with backoff", () => {
    instance = client(() => 0);
    const a = recorder();
    const b = recorder();
    instance.subscribe("busy", {}, a.listener);
    instance.subscribe("flaky", {}, b.listener);
    latest().open();
    latest().receive({ op: "denied", id: "1", code: "rate_limited" });
    latest().receive({ op: "denied", id: "2", code: "error" });
    expect(latest().subs()).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(latest().subs().slice(2)).toEqual([{ op: "sub", id: "2", ch: "flaky" }]);
    vi.advanceTimersByTime(4_000);
    expect(latest().subs().slice(3)).toEqual([{ op: "sub", id: "1", ch: "busy" }]);
    latest().receive({ op: "subscribed", id: "1", t: "busy" });
    expect(a.log.at(-1)).toBe("resync");
    expect(MockSocket.instances).toHaveLength(1);
  });

  test("limit is retried a few times on one socket, then waits for the next connection", () => {
    instance = client(() => 0);
    const a = recorder();
    instance.subscribe("full", {}, a.listener);
    latest().open(600_000);
    for (let i = 0; i < MAX_LIMIT_RETRIES; i++) {
      latest().receive({ op: "denied", id: "1", code: "limit" });
      vi.advanceTimersByTime(1_000);
    }
    expect(latest().subs()).toHaveLength(1 + MAX_LIMIT_RETRIES);
    latest().receive({ op: "denied", id: "1", code: "limit" });
    vi.advanceTimersByTime(120_000);
    expect(latest().subs()).toHaveLength(1 + MAX_LIMIT_RETRIES);
    // A new socket tries again, with a fresh count.
    latest().drop();
    vi.advanceTimersByTime(1_000);
    expect(MockSocket.instances).toHaveLength(2);
    latest().open(600_000);
    expect(latest().subs()).toEqual([{ op: "sub", id: "1", ch: "full" }]);
    latest().receive({ op: "denied", id: "1", code: "limit" });
    vi.advanceTimersByTime(1_000);
    expect(latest().subs()).toHaveLength(2);
  });

  test("denied and revoked wait for the next connection", () => {
    instance = client(() => 0);
    const a = recorder();
    instance.subscribe("site", {}, a.listener);
    latest().open(600_000);
    latest().receive({ op: "denied", id: "1", code: "revoked" });
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
    expect(latest().subs()).toHaveLength(1);
  });

  test("a permanent denial is not resent on reconnect; a retryable one is", () => {
    instance = client(() => 0);
    const a = recorder();
    const b = recorder();
    instance.subscribe("nope", {}, a.listener);
    instance.subscribe("flaky", {}, b.listener);
    latest().open();
    latest().receive({ op: "denied", id: "1", code: "unknown_channel" });
    latest().receive({ op: "denied", id: "2", code: "error" });
    expect(a.log.at(-1)).toBe("status:denied:unknown_channel");
    expect(b.log.at(-1)).toBe("status:denied:error");
    latest().drop();
    vi.advanceTimersByTime(1_000);
    latest().open();
    expect(latest().subs()).toEqual([{ op: "sub", id: "2", ch: "flaky" }]);
  });

  test("a hidden tab disconnects after the grace period and resyncs when shown", () => {
    instance = client();
    const a = recorder();
    instance.subscribe("status", {}, a.listener);
    // A heartbeat longer than the grace, so only the hidden timer closes it.
    latest().open(600_000);
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(59_999);
    expect(latest().closedWith).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(latest().closedWith).toBe(1000);
    vi.advanceTimersByTime(120_000);
    expect(MockSocket.instances).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(MockSocket.instances).toHaveLength(2);
    latest().open();
    latest().receive({ op: "subscribed", id: "1", t: "status" });
    expect(a.log.filter((l) => l === "resync")).toHaveLength(2);
  });
});
