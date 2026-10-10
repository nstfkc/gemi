import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { Repository } from "../../support/Repository";
import type { BroadcastRevocation } from "./BroadcastDriver";
import { BroadcastManager } from "./BroadcastManager";
import { assertSharedSecret } from "./BroadcastServiceProvider";
import { MemoryBroadcastDriver } from "./MemoryBroadcastDriver";
import { RedisBroadcastDriver, type RedisPubSubClient } from "./RedisBroadcastDriver";
import { memoryBroadcastInWorker } from "./workerWarning";

/**
 * A Redis server in memory, with Bun's client semantics where the driver
 * leans on them: a SUBSCRIBE adds a listener (twice adds it twice), an
 * UNSUBSCRIBE without one drops them all, and a dropped connection fires
 * `onclose` and loses its subscriptions.
 */
class FakeRedisServer {
  readonly clients = new Set<FakeClient>();
  up = true;
  /** Pings go unanswered while set. */
  deaf = false;
  /** Every SUBSCRIBE/UNSUBSCRIBE, in order, as "+chan" / "-chan". */
  readonly log: string[] = [];

  client = (role: "publisher" | "subscriber"): RedisPubSubClient => new FakeClient(this, role);

  publish(channel: string, message: string): number {
    let receivers = 0;
    for (const client of this.clients) {
      const listeners = client.subs.get(channel);
      if (!listeners) continue;
      receivers++;
      for (const listener of listeners) queueMicrotask(() => listener(message, channel));
    }
    return receivers;
  }

  /** Cuts every connection, as a restart or a network drop would. */
  dropAll() {
    // A copy: `drop` removes the client from the set.
    for (const client of Array.from(this.clients)) client.drop();
  }

  subscribers(channel: string): number {
    let n = 0;
    for (const client of this.clients) n += client.subs.get(channel)?.length ?? 0;
    return n;
  }
}

class FakeClient implements RedisPubSubClient {
  onclose: ((error: Error) => void) | null = null;
  readonly subs = new Map<string, Array<(message: string, channel: string) => void>>();
  private open = false;
  private failed = false;

  constructor(
    private readonly server: FakeRedisServer,
    readonly role: string,
  ) {}

  private async ensure() {
    await Promise.resolve();
    if (this.failed) throw new Error("Connection has failed");
    if (this.open) return;
    if (!this.server.up) {
      this.failed = true;
      queueMicrotask(() => this.onclose?.(new Error("Connection closed")));
      throw new Error("Connection closed");
    }
    this.open = true;
    this.server.clients.add(this);
  }

  connect() {
    return this.ensure();
  }

  async publish(channel: string, message: string) {
    await this.ensure();
    return this.server.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string, channel: string) => void) {
    await this.ensure();
    this.server.log.push(`+${channel}`);
    const list = this.subs.get(channel) ?? [];
    list.push(listener);
    this.subs.set(channel, list);
    return this.subs.size;
  }

  async unsubscribe(channel: string) {
    await this.ensure();
    this.server.log.push(`-${channel}`);
    this.subs.delete(channel);
  }

  async ping() {
    await this.ensure();
    if (this.server.deaf) return new Promise<never>(() => {});
    return "PONG";
  }

  close() {
    this.open = false;
    this.failed = true;
    this.subs.clear();
    this.server.clients.delete(this);
    this.onclose?.(new Error("Connection closed"));
  }

  drop() {
    if (!this.open) return;
    this.open = false;
    this.failed = true;
    this.subs.clear();
    this.server.clients.delete(this);
    this.onclose?.(new Error("Connection closed"));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const drivers: RedisBroadcastDriver[] = [];

function instance(server: FakeRedisServer, options: { healthCheckMs?: number } = {}) {
  const driver = new RedisBroadcastDriver({
    createClient: server.client,
    subscribeTimeoutMs: 200,
    healthCheckMs: options.healthCheckMs ?? 0,
  });
  drivers.push(driver);
  const delivered: Array<[string, string]> = [];
  const revoked: BroadcastRevocation[] = [];
  let gaps = 0;
  const start = () =>
    driver.start((topic, frame) => delivered.push([topic, frame]), {
      onGap: () => gaps++,
      onRevoke: (revocation) => revoked.push(revocation),
    });
  return { driver, delivered, revoked, gaps: () => gaps, start };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) await driver.close();
});

describe("RedisBroadcastDriver", () => {
  test("an emit reaches every process with sockets on the topic, the sender's included, once", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    const b = instance(server);
    const c = instance(server);
    await Promise.all([a.start(), b.start(), c.start()]);
    await a.driver.topicAdded("site.1");
    await b.driver.topicAdded("site.1");

    await a.driver.publish("site.1", "frame-1");
    await tick();

    expect(a.delivered).toEqual([["site.1", "frame-1"]]);
    expect(b.delivered).toEqual([["site.1", "frame-1"]]);
    // No sockets on it: not subscribed, nothing delivered.
    expect(c.delivered).toEqual([]);
    expect(server.subscribers("gemi:bc:site.1")).toBe(2);
  });

  test("a process without sockets publishes without subscribing (a queue worker)", async () => {
    const server = new FakeRedisServer();
    const web = instance(server);
    const worker = instance(server);
    await web.start();
    await web.driver.topicAdded("user.7");

    await worker.driver.publish("user.7", "credits");
    await tick();

    expect(web.delivered).toEqual([["user.7", "credits"]]);
    expect([...server.clients].map((client) => (client as FakeClient).role).sort()).toEqual([
      "publisher",
      "subscriber",
    ]);
  });

  test("SUBSCRIBE on the first socket, UNSUBSCRIBE on the last", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    await a.start();
    await a.driver.topicAdded("t");
    await a.driver.topicRemoved("t");
    expect(server.log).toEqual(["+gemi:bc:__control", "+gemi:bc:t", "-gemi:bc:t"]);
    await a.driver.publish("t", "late");
    await tick();
    expect(a.delivered).toEqual([]);
  });

  test("interleaved joins and leaves for one topic end where the last one left it", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    await a.start();

    // Leave, then a join in the next tick, while the first join is pending.
    await Promise.all([
      a.driver.topicAdded("t"),
      a.driver.topicRemoved("t"),
      a.driver.topicAdded("t"),
    ]);
    expect(server.subscribers("gemi:bc:t")).toBe(1);
    await a.driver.publish("t", "once");
    await tick();
    expect(a.delivered).toEqual([["t", "once"]]);

    await Promise.all([
      a.driver.topicRemoved("t"),
      a.driver.topicAdded("t"),
      a.driver.topicRemoved("t"),
    ]);
    expect(server.subscribers("gemi:bc:t")).toBe(0);
  });

  test("a join retried after a rejected one subscribes", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    await a.start();
    server.dropAll();
    server.up = false;
    await expect(a.driver.topicAdded("t")).rejects.toThrow();
    // The transport forgets the failed join; the next socket joins again.
    a.driver.topicRemoved("t");
    server.up = true;
    await a.driver.topicAdded("t");
    expect(server.subscribers("gemi:bc:t")).toBe(1);
  });

  test("a dropped subscriber reconnects, resubscribes and reports a gap", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    const b = instance(server);
    await Promise.all([a.start(), b.start()]);
    await b.driver.topicAdded("t");
    expect(b.gaps()).toBe(0);

    server.dropAll();
    // Published while b is reconnecting: lost, which the gap covers.
    await a.driver.publish("t", "lost").catch(() => {});
    await until(() => b.driver.connected && b.gaps() === 1);

    expect(server.subscribers("gemi:bc:t")).toBe(1);
    await a.driver.publish("t", "after");
    await tick();
    expect(b.delivered).toEqual([["t", "after"]]);
    expect(b.gaps()).toBe(1);
  });

  test("a Redis that is down at boot does not hold the server; the first connection is no gap", async () => {
    const server = new FakeRedisServer();
    server.up = false;
    const a = instance(server);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await a.start();
    expect(a.driver.connected).toBe(false);
    server.up = true;
    await until(() => a.driver.connected);
    expect(a.gaps()).toBe(0);
  });

  test("an unanswered ping drops the subscriber and reconnects", async () => {
    const server = new FakeRedisServer();
    const a = instance(server, { healthCheckMs: 20 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await a.start();
    await a.driver.topicAdded("t");
    server.deaf = true;
    await until(() => !a.driver.connected);
    server.deaf = false;
    await until(() => a.driver.connected && a.gaps() === 1);
    expect(server.subscribers("gemi:bc:t")).toBe(1);
  });

  test("a revocation is applied once by every process: at once here, through Redis elsewhere", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    const b = instance(server);
    await Promise.all([a.start(), b.start()]);

    await a.driver.revoke({ topic: "site.1" });
    await a.driver.revoke({ user: "42" });
    await tick();

    expect(a.revoked).toEqual([{ topic: "site.1" }, { user: "42" }]);
    expect(b.revoked).toEqual([{ topic: "site.1" }, { user: "42" }]);
  });

  test("a malformed control message is ignored", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    await a.start();
    server.publish("gemi:bc:__control", "nope");
    server.publish("gemi:bc:__control", JSON.stringify({ op: "revoke", from: "x", r: { all: 1 } }));
    await tick();
    expect(a.revoked).toEqual([]);
  });

  test("a publisher that gave up is replaced on the next emit", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    const b = instance(server);
    await b.start();
    await b.driver.topicAdded("t");
    server.up = false;
    await expect(a.driver.publish("t", "x")).rejects.toThrow();
    server.up = true;
    await until(() => b.driver.connected);
    await a.driver.publish("t", "y");
    await tick();
    expect(b.delivered.map(([, frame]) => frame)).toContain("y");
  });

  test("close releases both connections and stops delivering", async () => {
    const server = new FakeRedisServer();
    const a = instance(server);
    await a.start();
    await a.driver.topicAdded("t");
    await a.driver.publish("t", "1");
    await a.driver.close();
    expect(server.clients.size).toBe(0);
    server.publish("gemi:bc:t", "2");
    await tick();
    expect(a.delivered.map(([, frame]) => frame)).toEqual(["1"]);
  });

  test("the prefix names the channels", async () => {
    const server = new FakeRedisServer();
    const driver = new RedisBroadcastDriver({ createClient: server.client, prefix: "app2:" });
    drivers.push(driver);
    await driver.start(() => {});
    await driver.topicAdded("t");
    expect(server.log).toEqual(["+app2:__control", "+app2:t"]);
  });
});

describe("configuration", () => {
  test('driver "redis" builds the redis driver on the app\'s Redis connection', () => {
    const app = new Application(
      new Repository({ redis: { url: "redis://cache:6379" }, broadcast: { driver: "redis" } }),
    );
    const manager = new BroadcastManager(
      { driver: "redis", redis: { prefix: "x:" } },
      { application: app },
    );
    expect(manager.driver).toBeInstanceOf(RedisBroadcastDriver);
    const driver = manager.driver as RedisBroadcastDriver;
    expect(driver.prefix).toBe("x:");
    expect((driver as any).config.url).toBe("redis://cache:6379");
  });

  test("the broadcast config's own url wins", () => {
    const app = new Application(new Repository({ redis: { url: "redis://cache:6379" } }));
    const manager = new BroadcastManager(
      { driver: "redis", redis: { url: "redis://bus:6379" } },
      { application: app },
    );
    expect((manager.driver as any).config.url).toBe("redis://bus:6379");
  });

  test("SECRET is required for the redis driver: fails the boot in production, warns elsewhere", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertSharedSecret({ driver: "redis" }, { NODE_ENV: "production" })).toThrow(
      /needs SECRET/,
    );
    expect(() =>
      assertSharedSecret({ driver: "redis" }, { NODE_ENV: "production", SECRET: "s" }),
    ).not.toThrow();
    assertSharedSecret({ driver: "redis" }, { NODE_ENV: "development" });
    expect(warn).toHaveBeenCalledTimes(1);
    assertSharedSecret({ driver: "memory" }, { NODE_ENV: "production" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("queue:work warns about the memory driver only when the app declares channels", () => {
    class Channels {}
    const app = (config: Record<string, unknown>) => new Application(new Repository(config));
    expect(memoryBroadcastInWorker(app({}))).toBeNull();
    expect(memoryBroadcastInWorker(app({ route: { channels: Channels } }))).toMatch(/reach no one/);
    expect(
      memoryBroadcastInWorker(
        app({ route: { channels: Channels }, broadcast: { driver: new MemoryBroadcastDriver() } }),
      ),
    ).toMatch(/reach no one/);
    expect(
      memoryBroadcastInWorker(
        app({ route: { channels: Channels }, broadcast: { driver: "redis" } }),
      ),
    ).toBeNull();
  });
});
