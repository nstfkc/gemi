import { afterEach, describe, expect, test, vi } from "vitest";

import { Broadcast } from "../../facades/Broadcast";
import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { frameworkProviders } from "../../kernel/providers";
import { withTransaction } from "../../orm/context";
import { Repository } from "../../support/Repository";
import { Event } from "../events/Event";
import { EventServiceProvider } from "../events/EventServiceProvider";
import { Listener, type ListenerClass } from "../events/Listener";
import { QueueServiceProvider } from "../queue/QueueServiceProvider";
import type { BroadcastDriver } from "./BroadcastDriver";
import { BroadcastEvent } from "./BroadcastEvent";
import { BroadcastManager, BroadcastPayloadTooLargeError } from "./BroadcastManager";
import { BroadcastServiceProvider } from "./BroadcastServiceProvider";
import { InvalidChannelError } from "./channels";
import { FakeBroadcastManager } from "./FakeBroadcastManager";
import { MemoryBroadcastDriver } from "./MemoryBroadcastDriver";

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** A manager whose memory driver is started, and the frames it delivered. */
async function started(config: ConstructorParameters<typeof BroadcastManager>[0] = {}) {
  const manager = new BroadcastManager(config);
  const delivered: { topic: string; frame: any }[] = [];
  await manager.start((topic, frame) => delivered.push({ topic, frame: JSON.parse(frame) }));
  return { manager, delivered };
}

const SOCKET = "sock_abcdefgh12";

describe("BroadcastManager", () => {
  test("an emit before the transport starts reaches nobody, and does not throw", () => {
    const manager = new BroadcastManager();
    expect(manager.driver).toBeInstanceOf(MemoryBroadcastDriver);
    expect(() => manager.to("status").emit("deploy", { v: 1 })).not.toThrow();
    expect(manager.isStarted).toBe(false);
  });

  test("the memory driver delivers one frame per emit, naming its topic", async () => {
    const { manager, delivered } = await started();
    manager.to("site.:siteId", { siteId: "abc" }).emit("changed", { pages: ["/about"] });
    manager.to("status").emit("ping");
    expect(delivered).toEqual([
      {
        topic: "site.abc",
        frame: { op: "ev", t: "site.abc", ev: "changed", d: { pages: ["/about"] } },
      },
      { topic: "status", frame: { op: "ev", t: "status", ev: "ping" } },
    ]);
  });

  test("toUser and toOthers", async () => {
    const { manager, delivered } = await started();
    manager.toUser({ id: 42 }).emit("credits", { balance: 3 });
    const request = new Request("http://x/", { headers: { "X-Gemi-Socket": SOCKET } });
    manager.toOthers(request).to("page.:pageId", { pageId: "p1" }).emit("changed");
    manager.toOthers({ rawRequest: request }).toUser(7).emit("x");
    manager.toOthers("not a socket id!").to("status").emit("y");
    expect(delivered.map((d) => d.frame)).toEqual([
      { op: "ev", t: "user.42", ev: "credits", d: { balance: 3 } },
      { op: "ev", t: "page.p1", ev: "changed", x: SOCKET },
      { op: "ev", t: "user.7", ev: "x", x: SOCKET },
      { op: "ev", t: "status", ev: "y" },
    ]);
  });

  test("a bad channel or event name throws at the call site", () => {
    const manager = new BroadcastManager();
    expect(() => manager.to("site.:siteId" as string).emit("x")).toThrow(InvalidChannelError);
    expect(() => manager.to("site.:siteId", { siteId: "a.b" }).emit("x")).toThrow(
      InvalidChannelError,
    );
    expect(() => manager.to("status").emit("bad name")).toThrow(InvalidChannelError);
  });

  test("a payload that is not JSON throws", () => {
    const manager = new BroadcastManager();
    expect(() => manager.to("status").emit("x", { n: 1n })).toThrow(/must be JSON/);
  });

  test("payload size: a warning once per event above warnEventBytes, an error above maxEventBytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager, delivered } = await started({ warnEventBytes: 100, maxEventBytes: 300 });

    manager.to("status").emit("big", { s: "x".repeat(150) });
    manager.to("status").emit("big", { s: "x".repeat(150) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/"big" is \d+ bytes, over 100/);

    expect(() => manager.to("status").emit("huge", { s: "x".repeat(400) })).toThrow(
      BroadcastPayloadTooLargeError,
    );
    expect(delivered).toHaveLength(2);
  });

  test("the defaults are 4 KB to warn and 16 KB to refuse", () => {
    const manager = new BroadcastManager();
    expect(manager.config.warnEventBytes).toBe(4096);
    expect(manager.config.maxEventBytes).toBe(16384);
  });

  test("inside a transaction an emit waits for the commit", async () => {
    const { manager, delivered } = await started();
    await withTransaction(fakePool(), async () => {
      manager.to("status").emit("committed");
      expect(delivered).toEqual([]);
    });
    expect(delivered.map((d) => d.frame.ev)).toEqual(["committed"]);
  });

  test("and is dropped when it rolls back", async () => {
    const { manager, delivered } = await started();
    await expect(
      withTransaction(fakePool(), async () => {
        manager.to("status").emit("rolled-back");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(delivered).toEqual([]);
  });

  test("a failing driver is logged with the topic and event, never the payload", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver: BroadcastDriver = {
      publish: () => Promise.reject(new Error("down")),
      start: () => {},
      close: () => {},
    };
    const manager = new BroadcastManager({ driver });
    manager.to("status").emit("x", { secret: "s3cret" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('"x" on "status"');
    expect(JSON.stringify(error.mock.calls[0])).not.toContain("s3cret");
  });

  test("start can only be called once, and forwards topic hooks to the driver", async () => {
    const calls: string[] = [];
    const driver: BroadcastDriver = {
      publish: () => {},
      start: () => {
        calls.push("start");
      },
      topicAdded: (t) => {
        calls.push(`+${t}`);
      },
      topicRemoved: (t) => {
        calls.push(`-${t}`);
      },
      close: () => {
        calls.push("close");
      },
    };
    const manager = new BroadcastManager({ driver });
    await manager.start(() => {});
    await expect(manager.start(() => {})).rejects.toThrow(/already started/);
    await manager.topicAdded("a");
    await manager.topicRemoved("a");
    await manager.close();
    expect(calls).toEqual(["start", "+a", "-a", "close"]);
  });

  test("an unknown driver name is refused", () => {
    expect(() => new BroadcastManager({ driver: "redis" as any })).toThrow(
      /Unknown broadcast driver "redis"/,
    );
  });
});

describe("BroadcastServiceProvider", () => {
  async function makeApp(
    broadcast: Record<string, unknown> = {},
    route: Record<string, unknown> = {},
  ) {
    const application = new Application(new Repository({ broadcast, route }));
    application.registerMany([BroadcastServiceProvider]);
    await application.boot();
    return application;
  }

  test("is one of the providers every app boots with", () => {
    expect(frameworkProviders).toContain(BroadcastServiceProvider);
  });

  test("builds the manager from app/config/broadcast.ts, and the facade reaches it", async () => {
    const driver = new MemoryBroadcastDriver();
    const application = await makeApp({ driver: () => driver, maxEventBytes: 1000 });
    const manager = application.make(BroadcastManager);
    expect(manager.driver).toBe(driver);
    expect(manager.config.maxEventBytes).toBe(1000);

    const frames: string[] = [];
    await manager.start((_topic, frame) => frames.push(frame));
    kernelContext.run(application, () => {
      Broadcast.to("site.:siteId", { siteId: "s1" }).emit("changed");
    });
    expect(frames).toEqual(['{"op":"ev","t":"site.s1","ev":"changed"}']);
  });

  test("shutdown closes the driver", async () => {
    const application = await makeApp();
    const manager = application.make(BroadcastManager);
    await manager.start(() => {});
    await application.shutdown({ timeoutMs: 1_000 });
    expect((manager.driver as MemoryBroadcastDriver).started).toBe(false);
  });

  test("a malformed channel pattern fails the boot", async () => {
    const { ChannelRouter } = await import("../../http/ChannelRouter");
    class Channels extends ChannelRouter {
      channels = { "site.*": this.public() };
    }
    await expect(makeApp({}, { channels: Channels })).rejects.toThrow(InvalidChannelError);
  });
});

describe("Broadcast.fake()", () => {
  async function makeApp(listeners: ListenerClass[] = []) {
    const application = new Application(
      new Repository({ events: { listeners }, queue: { jobs: [], concurrency: 5 } }),
    );
    application.registerMany([
      QueueServiceProvider,
      EventServiceProvider,
      BroadcastServiceProvider,
    ]);
    await application.boot();
    return application;
  }

  test("records emits, asserts on them, and restore puts the real manager back", async () => {
    const application = await makeApp();
    const real = application.make(BroadcastManager);
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      expect(Broadcast.fake()).toBe(broadcasts);
      broadcasts.assertNothingSent();

      Broadcast.to("page.:pageId", { pageId: "p1" }).emit("changed", { pages: ["/about"] });
      Broadcast.toUser({ id: 9 }).emit("credits", { balance: 1 });
      Broadcast.to("site.s2").emit("changed");

      broadcasts.assertSent("page.:pageId");
      broadcasts.assertSent("page.:pageId", "changed", (d) => d.pages.includes("/about"));
      broadcasts.assertSent("page.p1", "changed");
      broadcasts.assertSent("user", "credits", (d) => d.balance === 1);
      broadcasts.assertSent("user.9");
      broadcasts.assertSent("site.:siteId", "changed");
      broadcasts.assertNotSent("page.:pageId", "deleted");
      broadcasts.assertNotSent("status");
      broadcasts.assertSentTimes("page.:pageId", 1);
      broadcasts.assertSentTimes("user", 1, "credits");

      expect(() => broadcasts.assertSent("status")).toThrow(
        /Expected an event on "status" to have been broadcast\. Broadcast: page\.p1 changed/,
      );
      expect(() => broadcasts.assertNotSent("page.:pageId")).toThrow(/broadcast 1 time/);
      expect(() => broadcasts.assertSentTimes("page.:pageId", 2)).toThrow(
        /2 times, but it was broadcast 1 time/,
      );
      expect(() => broadcasts.assertNothingSent()).toThrow(/3 emits were/);

      broadcasts.restore();
    });
    expect(application.make(BroadcastManager)).toBe(real);
  });

  test("still checks channels and sizes, and respects transactions", async () => {
    const application = await makeApp();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      expect(() => Broadcast.to("status").emit("x", { s: "x".repeat(20_000) })).toThrow(
        BroadcastPayloadTooLargeError,
      );
      await expect(
        withTransaction(fakePool(), async () => {
          Broadcast.to("status").emit("rolled-back");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await withTransaction(fakePool(), async () => {
        Broadcast.to("status").emit("committed");
        broadcasts.assertNothingSent();
      });
      broadcasts.assertSentTimes("status", 1, "committed");
      broadcasts.restore();
    });
  });

  test("fails with a clear message without a booted application", () => {
    expect(() => Broadcast.fake()).toThrow();
  });

  test("is a FakeBroadcastManager", async () => {
    const application = await makeApp();
    kernelContext.run(application, () => {
      const fake = Broadcast.fake();
      expect(fake).toBeInstanceOf(FakeBroadcastManager);
      fake.restore();
    });
  });
});

class SiteChanged extends BroadcastEvent<{ pages: string[] }, "changed"> {
  static name = "SiteChanged";
  constructor(
    public siteId: string,
    public pages: string[],
  ) {
    super();
  }
  broadcastOn() {
    return [this.channel("site.:siteId", { siteId: this.siteId }), "status"];
  }
  broadcastAs() {
    return "changed" as const;
  }
  broadcastWith() {
    return { pages: this.pages };
  }
}

class PageSaved extends BroadcastEvent {
  static name = "PageSaved";
  static afterCommit = true;
  constructor(public pageId: string) {
    super();
  }
  broadcastOn() {
    return this.channel("page.:pageId", { pageId: this.pageId });
  }
}

describe("BroadcastEvent", () => {
  async function makeApp(listeners: ListenerClass[] = []) {
    const application = new Application(
      new Repository({ events: { listeners }, queue: { jobs: [], concurrency: 5 } }),
    );
    application.registerMany([
      QueueServiceProvider,
      EventServiceProvider,
      BroadcastServiceProvider,
    ]);
    await application.boot();
    return application;
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("is an Event: listeners run, then it is broadcast to every channel it names", async () => {
    const order: string[] = [];
    class Audit extends Listener {
      static name = "Audit";
      static event = SiteChanged;
      handle(event: SiteChanged) {
        order.push(`listener:${event.siteId}`);
      }
    }
    const application = await makeApp([Audit]);
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      const record = broadcasts.sent;
      await SiteChanged.dispatchAndWait("s1", ["/about"]);
      order.push(`broadcast:${record.length}`);
      broadcasts.assertSent("site.:siteId", "changed", (d) => d.pages[0] === "/about");
      broadcasts.assertSent("status", "changed");
      expect(record[0]).toEqual({
        topic: "site.s1",
        pattern: "site.:siteId",
        event: "changed",
        data: { pages: ["/about"] },
      });
      broadcasts.restore();
    });
    expect(order).toEqual(["listener:s1", "broadcast:2"]);
  });

  test("needs no listener, and does not warn about having none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const application = await makeApp();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      PageSaved.dispatch("p1");
      await tick();
      // Defaults: the class name as the event, and no payload.
      expect(broadcasts.sent).toEqual([
        { topic: "page.p1", pattern: "page.:pageId", event: "PageSaved", data: undefined },
      ]);
      broadcasts.restore();
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("static afterCommit holds the broadcast with the listeners, and a rollback drops it", async () => {
    const application = await makeApp();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      await expect(
        withTransaction(fakePool(), async () => {
          PageSaved.dispatch("p1");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await withTransaction(fakePool(), async () => {
        PageSaved.dispatch("p2");
        broadcasts.assertNothingSent();
      });
      await tick();
      broadcasts.assertSentTimes("page.:pageId", 1);
      broadcasts.assertSent("page.p2");
      broadcasts.restore();
    });
  });

  test("under Event.fake() it is recorded as an event and not broadcast", async () => {
    const application = await makeApp();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      const events = Event.fake();
      SiteChanged.dispatch("s1", ["/"]);
      await tick();
      events.assertDispatched(SiteChanged, (e) => e.siteId === "s1");
      broadcasts.assertNothingSent();
      events.restore();
      broadcasts.restore();
    });
  });

  test("a refused broadcast is logged; the dispatch does not throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class Bad extends BroadcastEvent {
      static name = "Bad";
      broadcastOn() {
        return "site.:siteId";
      }
    }
    const application = await makeApp();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      await Bad.dispatchAndWait();
      broadcasts.assertNothingSent();
      broadcasts.restore();
    });
    expect(String(error.mock.calls[0][0])).toContain("The event Bad could not be broadcast");
  });
});

/**
 * Regressions from the review of #875: work started inside a transaction and
 * not awaited by it reaches `afterCommit` after the transaction settled,
 * through a scope that still carries its handle and its (drained) list.
 */
describe("emits that outlive their transaction", () => {
  async function makeApp(listeners: ListenerClass[] = []) {
    const application = new Application(
      new Repository({ events: { listeners }, queue: { jobs: [], concurrency: 5 } }),
    );
    application.registerMany([
      QueueServiceProvider,
      EventServiceProvider,
      BroadcastServiceProvider,
    ]);
    await application.boot();
    return application;
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  class Changed extends BroadcastEvent<undefined, "changed"> {
    static name = "Changed";
    broadcastOn() {
      return this.channel("page.:pageId", { pageId: "p1" });
    }
    broadcastAs() {
      return "changed" as const;
    }
  }
  class SlowListener extends Listener {
    static name = "SlowListener";
    static event = Changed;
    async handle() {
      await sleep(20);
    }
  }

  test("a BroadcastEvent whose sync listener awaits past the commit is still broadcast", async () => {
    const application = await makeApp([SlowListener]);
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      await withTransaction(fakePool(), async () => {
        Changed.dispatch();
      });
      await sleep(60);
      broadcasts.assertSentTimes("page.:pageId", 1, "changed");
      broadcasts.restore();
    });
  });

  test("and is dropped when that transaction rolled back", async () => {
    const application = await makeApp([SlowListener]);
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      await expect(
        withTransaction(fakePool(), async () => {
          Changed.dispatch();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await sleep(60);
      broadcasts.assertNothingSent();
      broadcasts.restore();
    });
  });

  test("an un-awaited emit after the commit is sent; after a rollback it is not", async () => {
    const { manager, delivered } = await started();
    await withTransaction(fakePool(), async () => {
      void sleep(10).then(() => manager.to("status").emit("late"));
    });
    await expect(
      withTransaction(fakePool(), async () => {
        void sleep(10).then(() => manager.to("status").emit("late-rolled-back"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await sleep(40);
    expect(delivered.map((d) => d.frame.ev)).toEqual(["late"]);
  });

  test("an emit inside a savepoint that rolls back is dropped; the outer commit sends the rest", async () => {
    const { manager, delivered } = await started();
    await withTransaction(fakePool(), async () => {
      manager.to("status").emit("outer");
      await withTransaction(fakePool(), async () => {
        manager.to("status").emit("inner");
        throw new Error("savepoint");
      }).catch(() => {});
    });
    expect(delivered.map((d) => d.frame.ev)).toEqual(["outer"]);
  });
});

describe("review follow-ups", () => {
  test('Broadcast.to("user") is refused: use toUser', () => {
    const manager = new BroadcastManager();
    expect(() => manager.to("user").emit("x")).toThrow(/Broadcast\.toUser/);
  });

  test('"__" segments are reserved', () => {
    const manager = new BroadcastManager();
    expect(() => manager.to("__control").emit("x")).toThrow(/reserved/);
  });

  test("a BroadcastEvent with one invalid target sends nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class Split extends BroadcastEvent {
      static name = "Split";
      broadcastOn() {
        return ["status", "site.:siteId"];
      }
    }
    const { manager, delivered } = await started();
    expect(() => manager.broadcastEvent(new Split())).toThrow(InvalidChannelError);
    expect(delivered).toEqual([]);
    error.mockRestore();
  });

  test("a failed driver start can be retried", async () => {
    let fail = true;
    const driver: BroadcastDriver = {
      publish: () => {},
      start: () => {
        if (fail) throw new Error("redis down");
      },
      close: () => {},
    };
    const manager = new BroadcastManager({ driver });
    await expect(manager.start(() => {})).rejects.toThrow("redis down");
    fail = false;
    await manager.start(() => {});
    expect(manager.isStarted).toBe(true);
  });

  test("the fake records what clients receive, not the caller's object", async () => {
    const application = new Application(new Repository({}));
    application.registerMany([BroadcastServiceProvider]);
    await application.boot();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      const data = { pages: ["/a"] };
      Broadcast.to("status").emit("changed", data);
      data.pages.push("/b");
      broadcasts.assertSent("status", "changed", (d) => d.pages.length === 1);
      broadcasts.restore();
    });
  });

  test("a malformed channel in an assertion throws instead of passing vacuously", async () => {
    const application = new Application(new Repository({}));
    application.registerMany([BroadcastServiceProvider]);
    await application.boot();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      expect(() => broadcasts.assertNotSent("site.:siteId..x")).toThrow(InvalidChannelError);
      expect(() => broadcasts.assertSentTimes("site.*", 0)).toThrow(InvalidChannelError);
      broadcasts.restore();
    });
  });

  test("the fake keeps the app's channels, so authorization still works under it", async () => {
    const { ChannelRouter } = await import("../../http/ChannelRouter");
    class Channels extends ChannelRouter {
      channels = { status: this.public() };
    }
    const application = new Application(new Repository({ route: { channels: Channels } }));
    application.registerMany([BroadcastServiceProvider]);
    await application.boot();
    await kernelContext.run(application, async () => {
      const broadcasts = Broadcast.fake();
      const router = application.make(BroadcastManager).channels;
      expect(router).toBeInstanceOf(Channels);
      expect(
        await router!.authorize(new Request("http://localhost/__gemi/socket"), "status"),
      ).toMatchObject({ ok: true, topic: "status" });
      broadcasts.restore();
    });
  });
});
