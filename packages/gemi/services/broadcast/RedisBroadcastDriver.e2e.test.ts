import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { ServerFrame } from "./protocol";

/**
 * The redis driver between two real processes (`__fixtures__/redisInstance.ts`)
 * on a real Redis: an emit made on one reaches sockets on the other, `toOthers`
 * tags match across them, revocations travel, and a dropped subscriber
 * connection comes back with a `gap`.
 *
 * Runs when `TEST_REDIS_URL` is set (CI's `redis` job brings a Redis service
 * up); skipped loudly otherwise, and failed instead when `CI_REDIS_REQUIRED=1`.
 */

const REDIS_URL = process.env.TEST_REDIS_URL;

if (!REDIS_URL) {
  describe("redis broadcast between processes", () => {
    const name = "did NOT run: set TEST_REDIS_URL";
    if (process.env.CI_REDIS_REQUIRED === "1") {
      test(name, () => {
        throw new Error("This run must reach Redis. Not set: TEST_REDIS_URL.");
      });
    } else {
      test.skip(name, () => {});
    }
  });
} else {
  suite(REDIS_URL);
}

type Instance = { port: number; proc: ReturnType<typeof Bun.spawn>; log: string[] };

type Client = {
  ws: WebSocket;
  hello: Extract<ServerFrame, { op: "hello" }>;
  frames: ServerFrame[];
  send(frame: unknown): void;
  next<O extends ServerFrame["op"]>(
    op: O,
    filter?: (frame: Extract<ServerFrame, { op: O }>) => boolean,
    ms?: number,
  ): Promise<Extract<ServerFrame, { op: O }>>;
  closed: Promise<{ code: number }>;
};

function suite(redisUrl: string) {
  const prefix = `gemi:e2e:${randomBytes(4).toString("hex")}:`;
  const fixture = path.join(import.meta.dirname, "__fixtures__/redisInstance.ts");
  let a: Instance;
  let b: Instance;
  const open: Client[] = [];

  async function start(): Promise<Instance> {
    const log: string[] = [];
    const proc = Bun.spawn(["bun", fixture], {
      env: {
        ...process.env,
        TEST_REDIS_URL: redisUrl,
        TEST_REDIS_PREFIX: prefix,
        SECRET: "redis-e2e-shared-secret",
        NODE_ENV: "production",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No "ready":\n${log.join("")}`)), 15_000);
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          const text = decoder.decode(chunk);
          log.push(text);
          const match = /ready (\d+)/.exec(text);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        }
      };
      void read(proc.stdout as ReadableStream<Uint8Array>);
      void read(proc.stderr as ReadableStream<Uint8Array>);
    });
    return { port, proc, log };
  }

  async function post(instance: Instance, route: string, body: unknown) {
    const res = await fetch(`http://127.0.0.1:${instance.port}${route}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  }

  /** A native-style socket (header auth, no cookies, no Origin). */
  async function connect(instance: Instance, user?: number): Promise<Client> {
    const headers: Record<string, string> = {};
    if (user !== undefined) headers["x-test-user"] = String(user);
    const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/__gemi/socket`, {
      protocols: ["gemi.v1"],
      headers,
    } as any);
    const frames: ServerFrame[] = [];
    const waiters = new Set<() => void>();
    ws.onmessage = (event) => {
      frames.push(JSON.parse(String(event.data)));
      for (const wake of waiters) wake();
    };
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (event) => resolve({ code: event.code }));
    });
    const next: Client["next"] = (op, filter, ms = 3_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const index = frames.findIndex(
            (frame) => frame.op === op && (!filter || filter(frame as any)),
          );
          if (index === -1) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(frames.splice(index, 1)[0] as any);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`No "${op}" frame within ${ms}ms. Got: ${JSON.stringify(frames)}`));
        }, ms);
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

  async function subscribe(
    client: Client,
    id: string,
    ch: string,
    p?: Record<string, string>,
  ): Promise<void> {
    client.send({ op: "sub", id, ch, ...(p ? { p } : {}) });
    await client.next("subscribed", (frame) => frame.id === id);
  }

  /** Nothing of `op` arrives within `ms`. */
  async function quiet(client: Client, op: ServerFrame["op"], ms = 300) {
    await expect(client.next(op, undefined, ms)).rejects.toThrow(/No/);
  }

  beforeAll(async () => {
    [a, b] = await Promise.all([start(), start()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(
      [a, b].map(async (instance) => {
        if (!instance) return;
        instance.proc.kill("SIGTERM");
        // A drain that hangs must not fail the suite: cut it.
        const timer = setTimeout(() => instance.proc.kill("SIGKILL"), 3_000);
        await instance.proc.exited;
        clearTimeout(timer);
      }),
    );
  }, 15_000);

  afterEach(async () => {
    await Promise.all(
      open.splice(0).map((client) => {
        client.ws.close();
        return client.closed;
      }),
    );
  });

  describe("redis broadcast between processes", () => {
    test("an emit on one instance reaches sockets on both", async () => {
      const onA = await connect(a);
      const onB = await connect(b);
      await subscribe(onA, "s", "status");
      await subscribe(onB, "s", "status");

      await post(b, "/emit", { channel: "status", event: "deploy", data: { v: 1 } });

      expect(await onA.next("ev")).toMatchObject({ t: "status", ev: "deploy", d: { v: 1 } });
      expect(await onB.next("ev")).toMatchObject({ t: "status", ev: "deploy", d: { v: 1 } });
    });

    test("an emit from an instance with no socket on the topic still reaches the others", async () => {
      const onA = await connect(a, 5);
      await subscribe(onA, "u", "user");
      await post(b, "/emit", { channel: "user.5", event: "credits", data: { balance: 3 } });
      expect(await onA.next("ev")).toMatchObject({ t: "user.5", ev: "credits" });
    });

    test("toOthers: the sender's socket, on another instance, recognises its own tag", async () => {
      const sender = await connect(a);
      const other = await connect(b);
      await subscribe(sender, "s", "status");
      await subscribe(other, "s", "status");

      // The save request reached instance b, carrying a's socket id.
      await post(b, "/emit", { channel: "status", event: "saved", except: sender.hello.socketId });

      const toSender = await sender.next("ev");
      const toOther = await other.next("ev");
      // `x` is computed on b, and must equal the tag a gave the sender: the
      // client drops a frame whose `x` is its own tag.
      expect(toSender.x).toBe(sender.hello.tag);
      expect(toOther.x).toBe(sender.hello.tag);
      expect(other.hello.tag).not.toBe(sender.hello.tag);
    });

    test("revoke { user } on one instance closes that user's sockets on the other", async () => {
      const onA = await connect(a, 21);
      const bystander = await connect(a, 22);
      await post(b, "/revoke", { user: 21 });
      expect((await onA.closed).code).toBe(4001);
      await subscribe(bystander, "s", "status");
    });

    test("revoke { channel } re-authorizes the topic on every instance", async () => {
      await post(a, "/members", { member: "1:t1", add: true });
      await post(a, "/members", { member: "2:t1", add: true });
      const alice = await connect(a, 1);
      const bob = await connect(a, 2);
      await subscribe(alice, "team", "team.:teamId", { teamId: "t1" });
      await subscribe(bob, "team", "team.:teamId", { teamId: "t1" });

      await post(a, "/members", { member: "1:t1", add: false });
      await post(b, "/revoke", { channel: "team.:teamId", params: { teamId: "t1" } });

      expect(await alice.next("denied")).toMatchObject({ id: "team", code: "revoked" });
      // Bob stays, with a fresh `subscribed` (a resync).
      await bob.next("subscribed", (frame) => frame.id === "team");
      await post(b, "/emit", { channel: "team.:teamId", params: { teamId: "t1" }, event: "x" });
      expect(await bob.next("ev")).toMatchObject({ t: "team.t1", ev: "x" });
      await quiet(alice, "ev");
    });

    test("a dropped subscriber connection reconnects and sends its sockets a gap", async () => {
      const onA = await connect(a);
      await subscribe(onA, "s", "status");

      const admin = new Bun.RedisClient(redisUrl);
      try {
        // Every pub/sub connection: both instances' subscribers.
        await admin.send("CLIENT", ["KILL", "TYPE", "pubsub"]);
      } finally {
        admin.close();
      }

      expect(await onA.next("gap", undefined, 10_000)).toEqual({ op: "gap" });
      await post(b, "/emit", { channel: "status", event: "after" });
      expect(await onA.next("ev")).toMatchObject({ ev: "after" });
    }, 20_000);
  });
}
