import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { withTransaction } from "../../orm/context";
import { Repository } from "../../support/Repository";
import { MemoryQueueDriver } from "../queue/MemoryQueueDriver";
import { QueueManager } from "../queue/QueueManager";
import type { QueueConfig } from "../queue/config";
import { QueueServiceProvider } from "../queue/QueueServiceProvider";
import { Event } from "./Event";
import { EventManager } from "./EventManager";
import { EventServiceProvider } from "./EventServiceProvider";
import { jobForListener } from "./listenerJob";
import { Listener, type ListenerClass } from "./Listener";

/**
 * `queued = true`, from the dispatch to the far side of the queue.
 *
 * Nothing here re-tests retries or dead-lettering as behaviour — those are the
 * queue's and `QueueManager.test.ts` owns them. What is tested is that a queued
 * listener reaches that machinery at all, because every way it can fail to is
 * silent: a synthetic job the queue was never told about is a dropped dispatch
 * on stderr long after `dispatch` returned, a payload the far side cannot read
 * is an event with `undefined` fields, and a listener that is queued when the
 * author thought it was sync is a side effect that has not happened yet when
 * the response goes out.
 *
 * The queue drains in process: the first `push` starts the worker loop, so a
 * job is often *finished* a tick after `push` returns. Tests that need to
 * observe the queued-but-not-yet-run state therefore stop the queue first and
 * start it again afterwards.
 */

class UserRegistered extends Event {
  static name = "UserRegistered";

  constructor(
    public userId: number,
    public email: string,
  ) {
    super();
  }
}

/**
 * A listener built around a spy, queued or not. `static name` is declared on
 * every one of them, as a queued listener's registration requires.
 */
function listener(
  name: string,
  handle: (event: any) => void | Promise<void>,
  fields: Partial<Pick<Listener, "queued" | "maxAttempts" | "backoff" | "worker">> = {},
) {
  return {
    [name]: class extends Listener {
      static name = name;
      static event = UserRegistered;

      queued = fields.queued ?? true;
      maxAttempts = fields.maxAttempts ?? 3;
      backoff = fields.backoff ?? 0;
      worker = fields.worker ?? false;

      handle(received: UserRegistered) {
        return handle(received);
      }
    },
  }[name]!;
}

/**
 * A booted application holding the queue and the events provider, with both
 * registries declared rather than discovered.
 *
 * `concurrency: 5` is left from when a retry pushed from inside the failing
 * job's `catch` found its own slot still taken and slept a second; a finished
 * attempt now frees its slot before the retry is claimed, so it no longer
 * matters, and changing it would only churn the tests below. `queue` is merged
 * over it.
 */
async function makeApp(listeners: ListenerClass[], queue: QueueConfig = {}) {
  const application = new Application(
    new Repository({
      events: { listeners },
      queue: { jobs: [], concurrency: 5, ...queue },
    }),
  );
  application.registerMany([QueueServiceProvider, EventServiceProvider]);
  await application.boot();
  return application;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Everything a `console.error` spy saw, one string per call.
 *
 * Assertions about a queued listener's failure go through this rather than
 * through a spy on `Job.prototype.onDeadletter`, and the difference is the
 * point: the hooks are overridden on the synthetic job, so a prototype spy
 * would not fire, and stderr is the only thing an operator gets. A test that
 * watched the hook would pass over an implementation that writes nothing.
 */
const consoleLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => call.map(String).join(" "));

const deadletterLine = (spy: { mock: { calls: unknown[][] } }) =>
  consoleLines(spy).find((line) => line.includes("dead-lettered"));

/**
 * Jobs the memory driver holds, waiting or claimed — zero means nothing was
 * pushed, or everything pushed has ended.
 */
const held = (queue: QueueManager) => {
  const driver = queue.driver as MemoryQueueDriver;
  return driver.waiting + driver.leased;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dispatch with one sync listener and one queued", () => {
  test("runs the sync one and leaves the queued one on the queue", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("WriteAuditRow", () => void ran.push("sync"), { queued: false }),
      listener("SendWelcomeEmail", () => void ran.push("queued")),
    ]);
    const queue = application.make(QueueManager);

    // Stopped, so the entry is observable between being pushed and being run.
    await queue.stop();

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );

    expect(ran).toEqual(["sync"]);
    expect(held(queue)).toBe(1);

    // Started outside the application on purpose. The job needs one to
    // rebuild the event — it resolves the `EventManager` through `app()` — and
    // a queued listener carries none with it, so this passes only because the
    // manager enters the application it was registered in around every job.
    queue.start();
    await tick();

    expect(ran).toEqual(["sync", "queued"]);
    expect(held(queue)).toBe(0);
  });

  test("the queued listener is registered with the queue under a listener: name", async () => {
    const application = await makeApp([
      listener("WriteAuditRow", () => {}, { queued: false }),
      listener("SendWelcomeEmail", () => {}),
    ]);

    // Visible, deliberately: `registeredJobs` reports what the queue will run,
    // and a queued listener is something it will run. The prefix is what keeps
    // an author from looking for a job file they never wrote — and a sync
    // listener is not there at all, because the queue never hears about it.
    expect(
      application.make(QueueManager).registeredJobs.map((job) => job.name),
    ).toEqual(["listener:SendWelcomeEmail"]);
  });
});

// #563: the queue holds any dispatch made inside a transaction until the
// commit, and a queued listener's push is one — so it needs no `afterCommit`.
describe("a queued listener on an event dispatched inside a transaction", () => {
  const pool = () => {
    const handle: any = {};
    return { begin: (fn: (tx: any) => Promise<unknown>) => Promise.resolve().then(() => fn(handle)) } as any;
  };

  test("is recorded at the commit, while the sync one runs at once", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("WriteAuditRow", () => void ran.push("sync"), { queued: false }),
      listener("SendWelcomeEmail", () => void ran.push("queued")),
    ]);
    const queue = application.make(QueueManager);

    await kernelContext.run(application, () =>
      withTransaction(pool(), async () => {
        await UserRegistered.dispatchAndWait(7, "ada@example.com");
        await tick();
        expect(ran).toEqual(["sync"]);
        expect(held(queue)).toBe(0);
      }),
    );

    await tick();
    expect(ran).toEqual(["sync", "queued"]);
  });

  test("is never recorded when the transaction rolls back", async () => {
    const ran: string[] = [];
    const application = await makeApp([listener("SendWelcomeEmail", () => void ran.push("queued"))]);
    const queue = application.make(QueueManager);

    await expect(
      kernelContext.run(application, () =>
        withTransaction(pool(), async () => {
          await UserRegistered.dispatchAndWait(7, "ada@example.com");
          throw new Error("billing declined");
        }),
      ),
    ).rejects.toThrow("billing declined");

    await tick();
    expect(ran).toEqual([]);
    expect(held(queue)).toBe(0);
  });
});

describe("dispatchAndWait", () => {
  test("does not wait for a queued listener, whatever the name suggests", async () => {
    let release!: () => void;
    const settled: string[] = [];

    const application = await makeApp([
      listener(
        "SendWelcomeEmail",
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              settled.push("listener");
              resolve();
            };
          }),
      ),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );
    settled.push("caller");

    // The listener has started — the queue drained on push — and the caller
    // did not wait for it to finish. A sync listener would have reversed this.
    expect(settled).toEqual(["caller"]);

    release();
    await tick();
    expect(settled).toEqual(["caller", "listener"]);
  });
});

describe("what crosses the queue", () => {
  test("is the constructor's arguments, rebuilt into an event on the far side", async () => {
    const seen: UserRegistered[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", (event) => void seen.push(event)),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );
    await tick();

    expect(seen).toHaveLength(1);
    // Round-tripped through JSON as `["UserRegistered", [7, "ada@…"]]` and
    // rebuilt with `new UserRegistered(...)`, so the fields are equal and the
    // instance is not the one the dispatcher built. (`toBeInstanceOf` is safe
    // here for the reason it is unsafe in an application: one module graph.)
    expect(seen[0]).toBeInstanceOf(UserRegistered);
    expect(seen[0]!.userId).toBe(7);
    expect(seen[0]!.email).toBe("ada@example.com");
  });

  test("reaches the listener through the worker's entry point too", async () => {
    const seen: UserRegistered[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", (event) => void seen.push(event)),
    ]);

    // `dispatchJob` is what a worker thread calls on its cloned application,
    // and it hands `run` the parsed payload whole rather than spread — the one
    // asymmetry between the two ways the queue invokes a job. A job that reads
    // only the spread shape gets an event named `undefined` here.
    await kernelContext.run(application, () =>
      application
        .make(QueueManager)
        .dispatchJob(
          "listener:SendWelcomeEmail",
          JSON.stringify(["UserRegistered", [7, "ada@example.com"]]),
        ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.email).toBe("ada@example.com");
  });
});

describe("a queued listener that always throws", () => {
  test("is retried and dead-lettered by the queue, on its own maxAttempts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;

    const application = await makeApp([
      listener(
        "SendWelcomeEmail",
        () => {
          attempts++;
          throw new Error("smtp is down");
        },
        { maxAttempts: 2 },
      ),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );
    await vi.waitFor(() => expect(deadletterLine(error)).toBeDefined());

    // Two, not the queue's default of three: `maxAttempts` is read off the
    // listener and forwarded to the job it is registered as.
    expect(attempts).toBe(2);
    expect(held(application.make(QueueManager))).toBe(0);

    // `dispatchAndWait` resolved before the first attempt failed, so this line
    // is the entire signal that a side effect stopped happening. It names the
    // listener, the event it was bound to, and the error, the way the sync
    // path's own catch does.
    expect(deadletterLine(error)).toContain("SendWelcomeEmail");
    expect(deadletterLine(error)).toContain("UserRegistered");
    expect(deadletterLine(error)).toContain("smtp is down");
  });
});

describe("a queued listener with a backoff", () => {
  test("waits it out before the retry, as a job with that backoff would", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attempts: number[] = [];

    const application = await makeApp([
      listener(
        "SendWelcomeEmail",
        () => {
          attempts.push(Date.now());
          if (attempts.length === 1) throw new Error("smtp is down");
        },
        { backoff: 200 },
      ),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );
    await vi.waitFor(() => expect(attempts).toHaveLength(2), { timeout: 2_000 });

    // Without the forward the synthetic job keeps `Job`'s default of 0 and
    // the retry is claimed as soon as the failure frees its slot.
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(180);
  });
});

describe("a payload naming an event this process does not know", () => {
  test("dead-letters with the name in the message, off the queue", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const application = await makeApp([
      listener("SendWelcomeEmail", () => {}, { maxAttempts: 1 }),
    ]);
    const queue = application.make(QueueManager);
    const [job] = queue.registeredJobs;

    // Pushed rather than calling `rehydrate` directly, because the path is the
    // point: a payload already off the queue, reaching the synthetic job's
    // `run` in a process whose event registry has no `OrderPaid`. That is the
    // `worker = true` shape — a thread that booted a different build of the
    // application and discovered different listeners — and nothing above `run`
    // is still waiting to be told about it.
    await kernelContext.run(application, () =>
      queue.push(job!, JSON.stringify(["OrderPaid", []])),
    );
    await vi.waitFor(() => expect(deadletterLine(error)).toBeDefined());

    expect(deadletterLine(error)).toContain("SendWelcomeEmail");
    expect(deadletterLine(error)).toContain(
      'Cannot rebuild the event "OrderPaid"',
    );
  });
});

describe("a driver that cannot record the job", () => {
  test("is one listener's problem, reported, and not an unhandled rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = new MemoryQueueDriver();
    vi.spyOn(driver, "enqueue").mockRejectedValue(new Error("db is down"));
    const application = await makeApp(
      [listener("SendWelcomeEmail", () => {})],
      { driver },
    );

    // `push` rejects after `dispatchAndWait` has moved on, so nothing above
    // the manager's own `catch` is left to hear about it.
    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );
    await tick();

    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      "could not be queued for UserRegistered",
    );
    expect(String(vi.mocked(error).mock.calls[0]![1])).toContain("db is down");
  });
});

describe("a payload the queue cannot carry", () => {
  test("is one listener's problem, not the dispatch's", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", () => void ran.push("queued")),
      listener("WriteAuditRow", () => void ran.push("sync"), { queued: false }),
    ]);

    const circular: any = {};
    circular.self = circular;

    // JSON.stringify throws on it, and the throw happens on the dispatcher's
    // stack rather than the listener's — so without a catch it would reject
    // `dispatchAndWait`, which is documented never to, and take the sync
    // listener behind it down as well.
    await expect(
      kernelContext.run(application, () =>
        UserRegistered.dispatchAndWait(circular, "ada@example.com"),
      ),
    ).resolves.toBeUndefined();
    await tick();

    expect(ran).toEqual(["sync"]);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      "could not be queued for UserRegistered",
    );
  });
});

describe("the synthetic job", () => {
  const SendWelcomeEmail = listener("SendWelcomeEmail", () => {});

  test("declares its name the way a hand-written job does", () => {
    const job = jobForListener(SendWelcomeEmail, new SendWelcomeEmail());
    const name = Object.getOwnPropertyDescriptor(job, "name");

    expect(name?.value).toBe("listener:SendWelcomeEmail");
    // Pinned because it is easy to drop and nothing would fail if it were:
    // `Object.defineProperty` keeps the attributes it is not given, and a
    // class's own `name` is non-writable, so leaving the flag out produces a
    // descriptor that every "was this name declared?" check in the framework
    // reads as an implicit class binding. No such check is pointed at a
    // registered job today — they all walk a directory — and one moved to the
    // queue's registry would start reporting these as jobs the author never
    // wrote and cannot fix.
    expect(name?.writable).toBe(true);
  });

  test("forwards the listener's worker flag", () => {
    const Cpu = listener("ResizeAvatar", () => {}, { worker: true });

    expect(new (jobForListener(Cpu, new Cpu()))().worker).toBe(true);
  });

  test("forwards the listener's backoff", () => {
    const Patient = listener("SendWelcomeEmail", () => {}, { backoff: [1_000, 5_000] });

    expect(new (jobForListener(Patient, new Patient()))().backoff).toEqual([1_000, 5_000]);
  });

  test("is refused when the listener's name is the implicit class binding", () => {
    class SendWelcomeEmail extends Listener {
      static event = UserRegistered;
      queued = true;
      handle() {}
    }

    // The compiler cannot see this either: `static name` is inherited from the
    // base, and a class declaration shadows it with its own binding — which
    // reads the same string right up until a production build renames it.
    expect(() =>
      jobForListener(SendWelcomeEmail as ListenerClass, new SendWelcomeEmail()),
    ).toThrow("does not declare `static name`");
  });
});

describe("two queued listeners claiming one name", () => {
  test("register one job, and both are still reported", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];

    const application = await makeApp([
      listener("NotifyAdmins", () => void ran.push("auth")),
      listener("NotifyAdmins", () => void ran.push("billing")),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );
    await tick();

    expect(ran).toEqual(["auth"]);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'Two event listeners are named "NotifyAdmins"',
    );
    // The clash is refused where a listener name is claimed, so the queue is
    // never handed the second job at all — one entry, not a second collision
    // reported one layer down.
    expect(application.make(QueueManager).registeredJobs).toHaveLength(1);
    expect(application.make(EventManager).registeredListeners).toHaveLength(2);
  });
});

describe("an event dispatched straight at the manager", () => {
  test("cannot queue, and says so instead of queueing an empty payload", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", () => void ran.push("queued")),
    ]);

    // No constructor arguments, because an instance cannot be asked what it was
    // built with. Rebuilding from `[]` would hand the listener an event whose
    // every field is `undefined` and run it, which is the failure this refuses.
    await kernelContext.run(application, () =>
      application
        .make(EventManager)
        .dispatchAndWait(new UserRegistered(7, "ada@example.com")),
    );
    await tick();

    expect(ran).toEqual([]);
    expect(held(application.make(QueueManager))).toBe(0);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain("SendWelcomeEmail");
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      "without its constructor arguments",
    );
  });
});
