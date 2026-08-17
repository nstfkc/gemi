import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { Repository } from "../../support/Repository";
import { Job } from "../queue/Job";
import { QueueManager } from "../queue/QueueManager";
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
 * The queue drains in process: `push` starts the drain itself unless one is
 * already running, so a job is often *finished* by the time `push` returns.
 * Tests that need to observe the queued-but-not-yet-run state therefore claim
 * the queue as busy first, which is the state a real queue is in whenever
 * anything else is running.
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
  fields: Partial<Pick<Listener, "queued" | "maxAttempts" | "worker">> = {},
) {
  return {
    [name]: class extends Listener {
      static name = name;
      static event = UserRegistered;

      queued = fields.queued ?? true;
      maxAttempts = fields.maxAttempts ?? 3;
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
 * `concurrency: 5` for the reason `QueueManager.test.ts` uses it: a retry is
 * pushed from inside the failing job's own `catch`, before the active count has
 * been decremented, so a concurrency of 1 sends the queue into a one-second
 * timer between attempts.
 */
async function makeApp(listeners: ListenerClass[]) {
  const application = new Application(
    new Repository({
      events: { listeners },
      queue: { jobs: [], concurrency: 5 },
    }),
  );
  application.registerMany([QueueServiceProvider, EventServiceProvider]);
  await application.boot();
  return application;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

    // Held, so the entry is observable between being pushed and being run.
    queue.isRunning = true;

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );

    expect(ran).toEqual(["sync"]);
    expect(queue.queue.size).toBe(1);

    // Driven inside the application, because that is what the job needs to
    // rebuild the event: a drain resolves the `EventManager` out of whatever
    // context it runs in, and a queued listener carries no application with it.
    queue.isRunning = false;
    await kernelContext.run(application, () => queue.next());
    await tick();

    expect(ran).toEqual(["sync", "queued"]);
    expect(queue.queue.size).toBe(0);
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
    const deadlettered = vi.spyOn(Job.prototype, "onDeadletter");
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
    await vi.waitFor(() => expect(deadlettered).toHaveBeenCalled());

    // Two, not the queue's default of three: `maxAttempts` is read off the
    // listener and forwarded to the job it is registered as.
    expect(attempts).toBe(2);
    expect((deadlettered.mock.calls[0]![0] as Error).message).toBe(
      "smtp is down",
    );
    expect(application.make(QueueManager).queue.size).toBe(0);
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
    // Writable is the whole point of the redefinition, not a detail of it:
    // discovery tells a declared `static name` from an implicit class binding
    // by exactly this descriptor, so a non-writable one would be reported at
    // every boot as a job the author never wrote and cannot fix.
    expect(name?.writable).toBe(true);
  });

  test("forwards the listener's worker flag", () => {
    const Cpu = listener("ResizeAvatar", () => {}, { worker: true });

    expect(new (jobForListener(Cpu, new Cpu()))().worker).toBe(true);
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
    expect(application.make(QueueManager).queue.size).toBe(0);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain("SendWelcomeEmail");
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      "without its constructor arguments",
    );
  });
});
