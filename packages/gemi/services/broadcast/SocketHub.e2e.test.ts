import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Broadcast } from "../../facades/Broadcast";
import { ChannelRouter } from "../../http/ChannelRouter";
import { RequestBreakerError } from "../../http/Error";
import { Middleware } from "../../http/Middleware";
import { Kernel } from "../../kernel";
import { drain, resetShuttingDown } from "../../server/shutdown";
import type { BroadcastDeliver, BroadcastDriver, BroadcastDriverHooks } from "./BroadcastDriver";
import { MemoryBroadcastDriver } from "./MemoryBroadcastDriver";
import type { ServerFrame } from "./protocol";

/**
 * The transport end to end: a real `Bun.serve` wired the way `httpProd` wires
 * it, real WebSocket clients, and the app's own `ChannelRouter`.
 *
 * Who the subscriber is comes from a global middleware that signs in the
 * user a `test_user` cookie (or header) names, which is how an app's SSO
 * gate would: the hub carries what the global middleware resolved.
 */

class TestUser extends Middleware {
  async run() {
    // `x-slow`: a session lookup that takes a while.
    const slow = Number(this.req.headers.get("x-slow") ?? 0);
    if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
    const raw =
      this.req.cookies.get("test_user") ?? this.req.headers.get("x-test-user") ?? undefined;
    if (raw) this.req.ctx().setUser({ id: Number(raw) });
  }
}

class Gate extends Middleware {
  run() {
    if (this.req.headers.get("x-blocked") === "1") {
      const error = new RequestBreakerError("blocked");
      error.payload = {
        api: { status: 451, data: { error: "blocked" } },
        view: { status: 451, error: { message: "blocked" } },
      };
      throw error;
    }
  }
}

/** `team.:teamId` membership, as "userId:teamId". */
const members = new Set<string>();
/** How long the `team` authorization takes after reading the membership. */
let teamAuthorizeDelayMs = 0;

class Channels extends ChannelRouter {
  channels = {
    // Reads the membership first, then waits: a slow query whose answer can
    // be stale by the time it returns.
    "team.:teamId": this.private(async (req, { teamId }) => {
      const member = members.has(`${req.ctx().user?.id}:${teamId}`);
      if (teamAuthorizeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, teamAuthorizeDelayMs));
      }
      return member;
    }),
    user: this.private(),
    status: this.public(),
    // Signed-in users may join the sites whose ids start with "s".
    "site.:siteId": this.private(
      (req, { siteId }) => req.ctx().user !== null && siteId.startsWith("s"),
    ),
  };
}

/** A memory driver whose `topicAdded` takes a while, and that remembers its hooks. */
class SlowDriver implements BroadcastDriver {
  private readonly memory = new MemoryBroadcastDriver();
  hooks: BroadcastDriverHooks | undefined;
  added: string[] = [];
  removed: string[] = [];
  delayMs = 0;
  publish(topic: string, frame: string) {
    this.memory.publish(topic, frame);
  }
  start(deliver: BroadcastDeliver, hooks?: BroadcastDriverHooks) {
    this.hooks = hooks;
    this.memory.start(deliver, hooks);
  }
  async topicAdded(topic: string) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.added.push(topic);
  }
  topicRemoved(topic: string) {
    this.removed.push(topic);
  }
  revoke(revocation: Parameters<NonNullable<BroadcastDriver["revoke"]>>[0]) {
    this.memory.revoke(revocation);
  }
  close() {
    this.memory.close();
  }
}

const driver = new SlowDriver();

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: { "test-user": TestUser, gate: Gate },
      global: ["gate", "test-user"],
    },
    route: {
      channels: Channels,
      api: { rootRouter: class extends ApiRouter {} },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
    broadcast: {
      driver,
      allowedOrigins: ["https://partner.example", "*.wild.example"],
      maxChannelsPerSocket: 4,
      maxConnectionsPerUser: 3,
      subscribeRate: { limit: 10, windowMs: 60_000 },
      backpressureLimit: 64 * 1024,
      heartbeatMs: 10_000,
    },
  };
}

let app: App;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  app = new App({ kernel: AppKernel });
  await app.waitForBoot();
  const sockets = app.sockets()!;
  server = Bun.serve<any>({
    port: 0,
    fetch: (req, server) =>
      sockets.matches(req) ? sockets.upgrade(req, server) : new Response("app", { status: 200 }),
    websocket: sockets.websocket,
  });
  await sockets.start(server);
  base = `localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
});

const open: Client[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((client) => {
      client.ws.close();
      return client.closed;
    }),
  );
  await settle();
  driver.delayMs = 0;
  members.clear();
  teamAuthorizeDelayMs = 0;
  vi.restoreAllMocks();
});

type Client = {
  ws: WebSocket;
  frames: ServerFrame[];
  hello: Extract<ServerFrame, { op: "hello" }>;
  send(frame: unknown): void;
  next<O extends ServerFrame["op"]>(
    op: O,
    filter?: (frame: Extract<ServerFrame, { op: O }>) => boolean,
  ): Promise<Extract<ServerFrame, { op: O }>>;
  closed: Promise<{ code: number; reason: string }>;
};

/** Opens a socket the way the browser client does, and waits for `hello`. */
async function connect(
  options: { cookie?: string; origin?: string | null; headers?: Record<string, string> } = {},
): Promise<Client> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.Cookie = options.cookie;
  const origin = options.origin === undefined ? `http://${base}` : options.origin;
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(`ws://${base}/__gemi/socket`, {
    protocols: ["gemi.v1"],
    headers,
  } as any);
  const frames: ServerFrame[] = [];
  const waiters = new Set<() => void>();
  ws.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)));
    for (const wake of waiters) wake();
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });
  const next: Client["next"] = (op, filter) =>
    new Promise((resolve, reject) => {
      let seen = 0;
      const check = () => {
        for (; seen < frames.length; seen++) {
          const frame = frames[seen] as any;
          if ((op === "*" ? true : frame.op === op) && (!filter || filter(frame))) {
            waiters.delete(check);
            clearTimeout(timer);
            frames.splice(seen, 1);
            resolve(frame);
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`No "${op}" frame within 2s. Got: ${JSON.stringify(frames)}`));
      }, 2_000);
      waiters.add(check);
      check();
    });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("The socket did not open.")), {
      once: true,
    });
  });
  const client: Client = {
    ws,
    frames,
    hello: undefined as any,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next,
    closed,
  };
  client.hello = await next("hello");
  open.push(client);
  return client;
}

/** An upgrade attempt over plain HTTP, to read the refusal's status. */
async function attempt(headers: Record<string, string>, path = "/__gemi/socket") {
  const res = await fetch(`http://${base}${path}`, {
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": btoa("0123456789abcdef"),
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Protocol": "gemi.v1",
      ...headers,
    },
  });
  await res.text();
  return res.status;
}

async function subscribe(client: Client, id: string, ch: string, p?: Record<string, string>) {
  client.send({ op: "sub", id, ch, ...(p ? { p } : {}) });
  // Either answer for this id: "*" matches any op.
  return (await client.next("*" as "subscribed", (f: any) =>
    (f.op === "subscribed" || f.op === "denied") && f.id === id,
  )) as Extract<ServerFrame, { op: "subscribed" | "denied" }>;
}

/** Lets the frames an emit produced reach the clients. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("the upgrade", () => {
  test("a socket opens with gemi.v1 and is greeted", async () => {
    const client = await connect();
    expect(client.ws.protocol).toBe("gemi.v1");
    expect(client.hello.socketId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(client.hello.tag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(client.hello.tag).not.toBe(client.hello.socketId);
    expect(client.hello.heartbeatMs).toBe(10_000);
  });

  test("ping is answered with pong", async () => {
    const client = await connect();
    client.send({ op: "ping" });
    await client.next("pong");
  });

  test("without the subprotocol, or without an upgrade, it is refused", async () => {
    expect(await attempt({ "Sec-WebSocket-Protocol": "chat" })).toBe(400);
    const plain = await fetch(`http://${base}/__gemi/socket`);
    expect(plain.status).toBe(426);
    expect(await plain.text()).toMatch(/WebSocket/);
  });

  test("a global middleware that refuses the request refuses the socket", async () => {
    expect(await attempt({ "x-blocked": "1" })).toBe(451);
  });

  test("a frame that is not JSON, or an unknown op, closes the socket with 1003", async () => {
    const client = await connect();
    client.ws.send("not json");
    expect((await client.closed).code).toBe(1003);
    const other = await connect();
    other.send({ op: "whisper" });
    expect((await other.closed).code).toBe(1003);
  });
});

describe("the Origin check", () => {
  test("a socket carrying cookies must name an allowed origin", async () => {
    expect(await attempt({ Cookie: "test_user=1" })).toBe(403);
    expect(await attempt({ Cookie: "test_user=1", Origin: "https://evil.example" })).toBe(403);
    expect(await attempt({ Cookie: "test_user=1", Origin: "null" })).toBe(403);
  });

  test("the app's own origin, allowedOrigins and APP_URL are allowed", async () => {
    await connect({ cookie: "test_user=1" });
    await connect({ cookie: "test_user=1", origin: "https://partner.example" });
    vi.stubEnv("APP_URL", "https://app.example");
    try {
      await connect({ cookie: "test_user=1", origin: "https://app.example" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("subdomains are not implied: not of APP_URL, nor of an allowed origin", async () => {
    vi.stubEnv("APP_URL", "https://example.com");
    try {
      const cookie = "test_user=1";
      expect(await attempt({ Cookie: cookie, Origin: "https://evil-tenant.example.com" })).toBe(
        403,
      );
      expect(await attempt({ Cookie: cookie, Origin: "https://tenant.partner.example" })).toBe(
        403,
      );
      await connect({ cookie, origin: "https://example.com" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a wildcard entry admits the subdomains, and not the host itself", async () => {
    await connect({ cookie: "test_user=1", origin: "https://tenant.wild.example" });
    await connect({ cookie: "test_user=1", origin: "http://a.b.wild.example" });
    expect(await attempt({ Cookie: "test_user=1", Origin: "https://wild.example" })).toBe(403);
    expect(await attempt({ Cookie: "test_user=1", Origin: "https://evilwild.example" })).toBe(403);
  });

  test("a native client with no cookies needs no Origin", async () => {
    const client = await connect({ origin: null, headers: { "x-test-user": "2" } });
    const ack = await subscribe(client, "u", "user");
    expect(ack).toEqual({ op: "subscribed", id: "u", t: "user.2" });
  });

  test("an Origin that is not allowed is refused even without cookies", async () => {
    expect(await attempt({ Origin: "https://evil.example" })).toBe(403);
  });
});

describe("authorization", () => {
  test("the user channel resolves to the session's user, and a guest is denied", async () => {
    const alice = await connect({ cookie: "test_user=7" });
    expect(await subscribe(alice, "a", "user")).toEqual({ op: "subscribed", id: "a", t: "user.7" });

    const guest = await connect();
    expect(await subscribe(guest, "g", "user")).toEqual({ op: "denied", id: "g", code: "denied" });
  });

  test("a private channel's callback decides, per params", async () => {
    const alice = await connect({ cookie: "test_user=7" });
    expect(await subscribe(alice, "mine", "site.:siteId", { siteId: "s1" })).toMatchObject({
      op: "subscribed",
      t: "site.s1",
    });
    expect(await subscribe(alice, "theirs", "site.:siteId", { siteId: "x2" })).toEqual({
      op: "denied",
      id: "theirs",
      code: "denied",
    });
  });

  test("unknown channels, bad params, a reused id and the per-socket limit are denied", async () => {
    const client = await connect({ cookie: "test_user=7" });
    expect(await subscribe(client, "a", "nope")).toMatchObject({ code: "unknown_channel" });
    expect(await subscribe(client, "b", "site.:siteId", { siteId: "a.b" })).toMatchObject({
      code: "invalid_params",
    });
    expect(await subscribe(client, "c", "status")).toMatchObject({ op: "subscribed" });
    expect(await subscribe(client, "c", "status")).toMatchObject({ code: "invalid" });
    await subscribe(client, "d", "user");
    await subscribe(client, "e", "site.:siteId", { siteId: "s1" });
    await subscribe(client, "f", "status");
    expect(await subscribe(client, "g", "status")).toMatchObject({ code: "limit" });
  });

  test("too many sub frames are rate limited, then the socket is closed", async () => {
    const client = await connect();
    for (let i = 0; i < 10; i++) {
      expect(await subscribe(client, `x${i}`, "nope")).toMatchObject({ code: "unknown_channel" });
    }
    expect(await subscribe(client, "late", "status")).toMatchObject({ code: "rate_limited" });
    for (let i = 0; i < 10; i++) client.send({ op: "sub", id: `y${i}`, ch: "status" });
    expect((await client.closed).code).toBe(1008);
  });

  test("unsub frames do not count against the rate limit", async () => {
    const client = await connect();
    for (let i = 0; i < 50; i++) client.send({ op: "unsub", id: `x${i}` });
    expect(await subscribe(client, "s", "status")).toMatchObject({ op: "subscribed" });
  });

  test("concurrent upgrades cannot overshoot the per-user cap while the session loads", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        connect({ cookie: "test_user=98", headers: { "x-slow": "50" } }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  test("connections per user are capped", async () => {
    await connect({ cookie: "test_user=99" });
    await connect({ cookie: "test_user=99" });
    await connect({ cookie: "test_user=99" });
    expect(await attempt({ Cookie: "test_user=99", Origin: `http://${base}` })).toBe(429);
  });
});

describe("delivery", () => {
  test("an emit reaches the sockets on its topic, and no one else", async () => {
    const alice = await connect({ cookie: "test_user=7" });
    const bob = await connect({ cookie: "test_user=8" });
    await subscribe(alice, "site", "site.:siteId", { siteId: "s1" });
    await subscribe(bob, "user", "user");

    Broadcast.to("site.:siteId", { siteId: "s1" }).emit("changed", { pages: ["/about"] });
    expect(await alice.next("ev")).toEqual({
      op: "ev",
      t: "site.s1",
      ev: "changed",
      d: { pages: ["/about"] },
    });
    Broadcast.toUser(8).emit("credits", { balance: 3 });
    expect(await bob.next("ev")).toMatchObject({ t: "user.8", ev: "credits" });
    await settle();
    expect(alice.frames.filter((f) => f.op === "ev")).toEqual([]);
    expect(bob.frames.filter((f) => f.op === "ev")).toEqual([]);
  });

  test("after unsub nothing more arrives, and the last one out releases the topic", async () => {
    const client = await connect();
    await subscribe(client, "s", "status");
    expect(driver.added).toContain("status");
    client.send({ op: "unsub", id: "s" });
    await settle();
    expect(driver.removed).toContain("status");
    Broadcast.to("status").emit("deploy");
    await settle();
    expect(client.frames.filter((f) => f.op === "ev")).toEqual([]);
  });

  test("two subscriptions on one topic: one frame each emit, and unsub of one keeps the other", async () => {
    const client = await connect();
    await subscribe(client, "one", "status");
    await subscribe(client, "two", "status");
    client.send({ op: "unsub", id: "one" });
    await settle();
    Broadcast.to("status").emit("deploy");
    await client.next("ev");
    await settle();
    expect(client.frames.filter((f) => f.op === "ev")).toEqual([]);
  });

  test("subscribed is sent only once the driver delivers the topic here", async () => {
    driver.delayMs = 100;
    const alice = await connect({ cookie: "test_user=7" });
    const started = Date.now();
    alice.send({ op: "sub", id: "slow", ch: "site.:siteId", p: { siteId: "s-slow" } });
    const ack = await alice.next("subscribed");
    expect(ack.t).toBe("site.s-slow");
    expect(driver.added).toContain("site.s-slow");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    // An emit right after the ack reaches the socket.
    Broadcast.to("site.:siteId", { siteId: "s-slow" }).emit("changed");
    await alice.next("ev");
  });

  test("toOthers: the frame names the sender by its tag, never its id", async () => {
    const sender = await connect();
    const other = await connect();
    await subscribe(sender, "s", "status");
    await subscribe(other, "s", "status");

    const request = new Request("http://app/api/save", {
      headers: { "X-Gemi-Socket": sender.hello.socketId },
    });
    Broadcast.toOthers(request).to("status").emit("saved");
    const toSender = await sender.next("ev");
    const toOther = await other.next("ev");
    expect(toSender.x).toBe(sender.hello.tag);
    expect(toOther.x).toBe(sender.hello.tag);
    expect(toOther.x).not.toBe(other.hello.tag);
    expect(JSON.stringify([toSender, toOther])).not.toContain(sender.hello.socketId);
  });

  test("a gap from the driver reaches every socket", async () => {
    const a = await connect();
    const b = await connect();
    driver.hooks?.onGap?.();
    await a.next("gap");
    await b.next("gap");
  });
});

describe("backpressure", () => {
  test("a socket that falls behind is closed with 1013", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const slow = await connect();
    await subscribe(slow, "s", "status");
    // One synchronous burst: nothing reaches the client while it runs, so
    // the server's buffer for the socket only grows.
    const chunk = "x".repeat(1_000);
    for (let i = 0; i < 20_000 && slow.ws.readyState === WebSocket.OPEN; i++) {
      Broadcast.to("status").emit("tick", { chunk });
    }
    const { code } = await slow.closed;
    expect(code).toBe(1013);
  });
});

describe("revoke", () => {
  test("{ user } closes that user's sockets with 4001, and only theirs", async () => {
    const alice = await connect({ cookie: "test_user=21" });
    const alice2 = await connect({ cookie: "test_user=21" });
    const bob = await connect({ cookie: "test_user=22" });
    Broadcast.revoke({ user: { id: 21 } });
    expect((await alice.closed).code).toBe(4001);
    expect((await alice2.closed).code).toBe(4001);
    await settle();
    expect(bob.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("revoke { channel }", () => {
  test("only the members who lost access are denied; the others keep receiving", async () => {
    members.add("31:t1");
    members.add("32:t1");
    const alice = await connect({ cookie: "test_user=31" });
    const bob = await connect({ cookie: "test_user=32" });
    expect(await subscribe(alice, "team", "team.:teamId", { teamId: "t1" })).toMatchObject({
      op: "subscribed",
    });
    expect(await subscribe(bob, "team", "team.:teamId", { teamId: "t1" })).toMatchObject({
      op: "subscribed",
    });

    members.delete("31:t1");
    Broadcast.revoke({ channel: "team.:teamId", params: { teamId: "t1" } });
    expect(await alice.next("denied")).toEqual({ op: "denied", id: "team", code: "revoked" });
    // Bob is authorized again and told so: his client resyncs.
    expect(await bob.next("subscribed")).toEqual({ op: "subscribed", id: "team", t: "team.t1" });

    Broadcast.to("team.:teamId", { teamId: "t1" }).emit("changed");
    expect(await bob.next("ev")).toMatchObject({ t: "team.t1", ev: "changed" });
    await settle();
    expect(alice.frames.filter((f) => f.op === "ev")).toEqual([]);
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
    expect(bob.frames.filter((f) => f.op === "denied")).toEqual([]);
  });

  test("an authorization that started before the revocation is run again", async () => {
    members.add("33:t2");
    teamAuthorizeDelayMs = 150;
    const alice = await connect({ cookie: "test_user=33" });
    alice.send({ op: "sub", id: "team", ch: "team.:teamId", p: { teamId: "t2" } });
    // The authorization has read the membership and is waiting.
    await new Promise((resolve) => setTimeout(resolve, 30));
    members.delete("33:t2");
    Broadcast.revoke({ channel: "team.:teamId", params: { teamId: "t2" } });
    const answer = await alice.next("*" as "denied", (f: any) => f.id === "team");
    expect(answer).toEqual({ op: "denied", id: "team", code: "denied" });
  });
});

describe("shutdown", () => {
  test("bye with 1012 and a jittered retryAfter, then the close; the drain does not wait on sockets", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const own = new App({ kernel: AppKernel });
    await own.waitForBoot();
    const sockets = own.sockets()!;
    const local = Bun.serve<any>({
      port: 0,
      fetch: (req, s) => (sockets.matches(req) ? sockets.upgrade(req, s) : new Response("app")),
      websocket: sockets.websocket,
    });
    try {
      await sockets.start(local);
      const ws = new WebSocket(`ws://localhost:${local.port}/__gemi/socket`, ["gemi.v1"]);
      const frames: any[] = [];
      ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      const closed = new Promise<number>((resolve) =>
        ws.addEventListener("close", (event) => resolve(event.code)),
      );
      await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
      await settle();

      const started = Date.now();
      const code = await drain({
        server: local,
        closeSockets: () => sockets.shutdown(),
        shutdownProviders: async () => ({ failed: [], timedOut: [] }) as any,
        settings: { timeoutMs: 10_000, delayMs: 0, providerTimeoutMs: 1_000 },
      });
      expect(code).toBe(0);
      // Well inside the drain budget: the sockets did not hold it up (the
      // hub terminates any still open after 2 s).
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await closed).toBe(1012);
      const bye = frames.find((f) => f.op === "bye");
      expect(bye.code).toBe(1012);
      expect(bye.retryAfter).toBeGreaterThanOrEqual(1_000);
      expect(bye.retryAfter).toBeLessThanOrEqual(5_000);
    } finally {
      resetShuttingDown();
      local.stop(true);
      await own.shutdown({ timeoutMs: 1_000 });
    }
  }, 20_000);

  test("once shutting down, upgrades are refused with 503", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const own = new App({ kernel: AppKernel });
    await own.waitForBoot();
    const sockets = own.sockets()!;
    const local = Bun.serve<any>({
      port: 0,
      fetch: (req, s) => (sockets.matches(req) ? sockets.upgrade(req, s) : new Response("app")),
      websocket: sockets.websocket,
    });
    try {
      sockets.shutdown();
      const res = await fetch(`http://localhost:${local.port}/__gemi/socket`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": btoa("0123456789abcdef"),
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": "gemi.v1",
        },
      });
      expect(res.status).toBe(503);
    } finally {
      local.stop(true);
      await own.shutdown({ timeoutMs: 1_000 });
    }
  });
});
