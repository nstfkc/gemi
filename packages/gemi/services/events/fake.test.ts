import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { withTransaction } from "../../orm/context";
import { Repository } from "../../support/Repository";
import { QueueManager } from "../queue/QueueManager";
import { QueueServiceProvider } from "../queue/QueueServiceProvider";
import { Event } from "./Event";
import { EventManager } from "./EventManager";
import { EventServiceProvider } from "./EventServiceProvider";
import { FakeEventManager } from "./FakeEventManager";
import { Listener, type ListenerClass } from "./Listener";

/**
 * `Event.fake()`: what a controller test asserts on instead of the side effect.
 *
 * The separation is the point. A test that asserts a welcome email was sent is
 * testing the controller, the listener and the mailer at once, and it breaks
 * when a fourth listener is added to an event it was never about. Asserting
 * that the *event* fired tests the controller alone — and the listener is
 * testable on its own terms, with no framework around it at all
 * (`new SendWelcomeEmail().handle(new UserRegistered(…))`).
 *
 * Two silences this file is arranged against. A fake that keeps running the
 * listeners tests nothing new; a fake that outlives its test makes every
 * listener in every test after it silently not run, with no warning to catch it
 * — a fake legitimately has no listeners, so the zero-listener line never fires.
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

class OrderPaid extends Event {
  static name = "OrderPaid";

  constructor(public orderId: number) {
    super();
  }
}

/** An `afterCommit` event, for the one interaction the two features have. */
class InvoiceIssued extends Event {
  static name = "InvoiceIssued";
  static afterCommit = true;

  constructor(public invoiceId: number) {
    super();
  }
}

function listener(
  name: string,
  event: EventClassUnderTest,
  handle: (event: any) => void | Promise<void>,
  isQueued = false,
) {
  return {
    [name]: class extends Listener {
      static name = name;
      static event = event;

      queued = isQueued;

      handle(received: any) {
        return handle(received);
      }
    },
  }[name]!;
}

type EventClassUnderTest =
  | typeof UserRegistered
  | typeof OrderPaid
  | typeof InvoiceIssued;

async function makeApp(listeners: ListenerClass[] = []) {
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

const fakePool = () => {
  const handle: any = {
    savepoint: (fn: (sp: any) => Promise<unknown>) =>
      Promise.resolve().then(() => fn(handle)),
  };
  return {
    begin: (fn: (tx: any) => Promise<unknown>) =>
      Promise.resolve().then(() => fn(handle)),
  } as any;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installing a fake", () => {
  /**
   * The fake is a container swap, and a test that reaches for one has usually
   * read it as the opposite — a way to absorb a dispatch *without* an
   * application. `app()`'s own "Boot a Kernel before resolving services" is
   * accurate and sends that reader looking for the service they did not ask to
   * resolve, so `Event.fake()` says what it needs and how little of a boot
   * covers it. Pinned because the message is the only thing standing between
   * that reader and the mechanism.
   */
  test("says what it needs when there is no application at all", () => {
    const previous = Application.getInstance();
    Application.setInstance(undefined);

    try {
      expect(() => Event.fake()).toThrow(/needs a booted application/);
      expect(() => Event.fake()).toThrow(/kernel\.boot\(\)/);
    } finally {
      Application.setInstance(previous);
    }
  });

  test("records the dispatch and runs no listener", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => void ran.push("mail")),
    ]);

    await kernelContext.run(application, async () => {
      const events = Event.fake();

      await UserRegistered.dispatchAndWait(7, "ada@example.com");

      expect(ran).toEqual([]);
      events.assertDispatched(UserRegistered);
      events.restore();
    });
  });

  test("is what the container hands out while it is installed", async () => {
    const application = await makeApp();

    await kernelContext.run(application, async () => {
      const events = Event.fake();
      expect(application.make(EventManager)).toBe(events);
      events.restore();
    });
  });

  /**
   * A fake set up in a shared helper and a `Event.fake()` in the body of the
   * test would otherwise be two recorders, and the one asserted on would be the
   * one that saw nothing.
   */
  test("a second call returns the same recorder", async () => {
    const application = await makeApp();

    await kernelContext.run(application, async () => {
      const first = Event.fake();
      UserRegistered.dispatch(7, "ada@example.com");
      const second = Event.fake();

      expect(second).toBe(first);
      second.assertDispatched(UserRegistered);
      first.restore();
    });
  });

  test("records both dispatch and dispatchAndWait, with their arguments", async () => {
    const application = await makeApp();

    await kernelContext.run(application, async () => {
      const events = Event.fake();

      UserRegistered.dispatch(7, "ada@example.com");
      await UserRegistered.dispatchAndWait(8, "grace@example.com");

      expect(events.dispatched.map((record) => record.args)).toEqual([
        [7, "ada@example.com"],
        [8, "grace@example.com"],
      ]);
      events.restore();
    });
  });
});

describe("restoring", () => {
  test("gives back the very manager the application had booted", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => void ran.push("mail")),
    ]);
    const real = application.make(EventManager);

    await kernelContext.run(application, async () => {
      Event.fake().restore();

      // The same object, not a second one built from the config slice: a
      // rebuilt manager would have an empty registry, and its queued listeners
      // would no longer be registered with the queue.
      expect(application.make(EventManager)).toBe(real);

      await UserRegistered.dispatchAndWait(7, "ada@example.com");
    });

    expect(ran).toEqual(["mail"]);
  });

  test("leaves an unresolved binding unresolved", async () => {
    const application = new Application(
      new Repository({ events: { listeners: [] } }),
    );
    // Registered but not booted, so the singleton factory has never run.
    application.register(EventServiceProvider);

    await kernelContext.run(application, async () => {
      Event.fake().restore();

      expect(application.resolved(EventManager)).toBe(false);
      expect(application.make(EventManager)).toBeInstanceOf(EventManager);
      expect(application.make(EventManager)).not.toBeInstanceOf(
        FakeEventManager,
      );
    });
  });

  test("is harmless twice", async () => {
    const application = await makeApp();

    await kernelContext.run(application, async () => {
      const events = Event.fake();
      events.restore();
      events.restore();

      expect(application.make(EventManager)).not.toBe(events);
    });
  });
});

/**
 * Nothing may reach `QueueManager`. Without this a controller test with a fake
 * still enqueues real work, which runs against the test database after the
 * assertions have passed — a failure that lands in whatever test is running
 * next, or in none at all.
 */
describe("a fake and a queued listener", () => {
  test("nothing reaches the queue", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener(
        "SendWelcomeEmail",
        UserRegistered,
        () => void ran.push("queued"),
        true,
      ),
    ]);
    const queue = application.make(QueueManager);

    await kernelContext.run(application, async () => {
      const events = Event.fake();
      await UserRegistered.dispatchAndWait(7, "ada@example.com");
      await tick();

      expect(queue.queue.size).toBe(0);
      expect(ran).toEqual([]);
      events.assertDispatched(UserRegistered);
      events.restore();
    });

    // The job is still registered with the queue — the fake replaces the
    // dispatcher, not the boot — so this says the push never happened rather
    // than that there was nothing to push to.
    expect(queue.registeredJobs.map((job) => job.name)).toEqual([
      "listener:SendWelcomeEmail",
    ]);
  });
});

describe("a fake and an afterCommit event", () => {
  test("records at the dispatch, without waiting for a commit", async () => {
    const application = await makeApp([
      listener("IssueReceipt", InvoiceIssued, () => {}),
    ]);

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        const events = Event.fake();
        InvoiceIssued.dispatch(3);

        // A fake short-circuits before the transaction check, so a controller
        // test does not have to commit anything to see what the controller
        // dispatched.
        events.assertDispatched(InvoiceIssued);
        events.restore();
      }),
    );
  });
});

describe("the assertions", () => {
  async function faked() {
    const application = await makeApp();
    const events = kernelContext.run(application, () => Event.fake());
    return { application, events };
  }

  test("assertDispatched matches by declared name, and takes a predicate", async () => {
    const { events } = await faked();

    events.dispatch(new UserRegistered(7, "ada@example.com"), [
      7,
      "ada@example.com",
    ]);

    events.assertDispatched(UserRegistered);
    events.assertDispatched(
      UserRegistered,
      (event) => event.email === "ada@example.com",
    );
    expect(() =>
      events.assertDispatched(UserRegistered, (event) => event.userId === 8),
    ).toThrow();
    events.restore();
  });

  /**
   * The message is most of what this feature is. The common failure is not
   * "nothing fired" but "that fired with a different payload", and printing
   * what was dispatched ends the investigation where it starts.
   */
  test("a failure names what was dispatched instead", async () => {
    const { events } = await faked();

    events.dispatch(new UserRegistered(2, "b@c.d"), [2, "b@c.d"]);

    expect(() => events.assertDispatched(OrderPaid)).toThrow(
      'Dispatched: UserRegistered(2, "b@c.d")',
    );
    expect(() => events.assertDispatched(OrderPaid)).toThrow(
      "Expected OrderPaid",
    );
    events.restore();
  });

  test("a failed predicate prints the dispatches of that event", async () => {
    const { events } = await faked();

    events.dispatch(new UserRegistered(2, "b@c.d"), [2, "b@c.d"]);
    events.dispatch(new OrderPaid(9), [9]);

    expect(() =>
      events.assertDispatched(UserRegistered, (event) => event.userId === 7),
    ).toThrow('Dispatched UserRegistered: UserRegistered(2, "b@c.d")');
    events.restore();
  });

  test("an empty recorder says so rather than printing an empty list", async () => {
    const { events } = await faked();

    expect(() => events.assertDispatched(UserRegistered)).toThrow(
      "Nothing was dispatched.",
    );
    events.restore();
  });

  /**
   * An instance dispatched straight at the manager carries no constructor
   * arguments — an instance cannot be asked what it was built with — and
   * printing it as `UserRegistered()` would read as a framework bug rather than
   * as a test that took a shortcut.
   */
  test("an argument-less dispatch is described by its fields", async () => {
    const { events } = await faked();

    events.dispatch(new UserRegistered(2, "b@c.d"));

    expect(() => events.assertDispatched(OrderPaid)).toThrow(
      'UserRegistered(2, "b@c.d")',
    );
    events.restore();
  });

  test("assertNotDispatched, whole and by predicate", async () => {
    const { events } = await faked();

    events.dispatch(new UserRegistered(7, "ada@example.com"), [
      7,
      "ada@example.com",
    ]);

    events.assertNotDispatched(OrderPaid);
    events.assertNotDispatched(UserRegistered, (event) => event.userId === 8);
    expect(() => events.assertNotDispatched(UserRegistered)).toThrow(
      "not to have been dispatched",
    );
    events.restore();
  });

  test("assertDispatchedTimes counts, and says both numbers when it fails", async () => {
    const { events } = await faked();

    events.dispatch(new OrderPaid(1), [1]);
    events.dispatch(new OrderPaid(2), [2]);

    events.assertDispatchedTimes(OrderPaid, 2);
    events.assertDispatchedTimes(OrderPaid, 1, (event) => event.orderId === 1);
    expect(() => events.assertDispatchedTimes(OrderPaid, 1)).toThrow(
      "dispatched 1 time, but it was dispatched 2 times",
    );
    events.restore();
  });

  test("assertNothingDispatched", async () => {
    const { events } = await faked();

    events.assertNothingDispatched();
    events.dispatch(new OrderPaid(1), [1]);

    expect(() => events.assertNothingDispatched()).toThrow(
      "Expected nothing to have been dispatched, but 1 event was: OrderPaid(1)",
    );
    events.restore();
  });
});
