import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { currentTransaction, withTransaction } from "../../orm/context";
import { Repository } from "../../support/Repository";
import { QueueManager } from "../queue/QueueManager";
import { QueueServiceProvider } from "../queue/QueueServiceProvider";
import { Event } from "./Event";
import { EventServiceProvider } from "./EventServiceProvider";
import { Listener, type ListenerClass } from "./Listener";

/**
 * `static afterCommit = true`, from the dispatch to the commit.
 *
 * What it is for, in one shape:
 *
 * ```typescript
 * await DB.transaction(async () => {
 *   const user = await User.create(input);
 *   UserRegistered.dispatch(user.id, user.email);   // welcome email sent
 *   await Billing.provision(user);                  // throws
 * });                                               // rolled back
 * ```
 *
 * The user does not exist and has been welcomed. Nothing errored — the email
 * succeeded and the transaction failed, in two subsystems that never meet — so
 * the only thing that can catch it is a test that rolls a transaction back and
 * asserts a listener did not run.
 *
 * `orm/context.test.ts` owns the mechanism: which scope holds the list, what a
 * savepoint does with it, and that two concurrent transactions keep their own.
 * This file owns the decision — which of the three cases in the table on
 * `EventManager.deferToCommit` a dispatch lands in.
 */

class UserRegistered extends Event {
  static name = "UserRegistered";
  static afterCommit = true;

  constructor(
    public userId: number,
    public email: string,
  ) {
    super();
  }
}

/** The same payload, dispatched the way iterations 1 and 2 dispatch it. */
class OrderPaid extends Event {
  static name = "OrderPaid";

  constructor(public orderId: number) {
    super();
  }
}

function listener(
  name: string,
  event: typeof UserRegistered | typeof OrderPaid,
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

/**
 * The smallest thing `withTransaction` calls, and the reason this file needs no
 * database: what is under test is which *scope* a dispatch lands in, and a fake
 * handle produces the commit and the rollback on demand.
 */
function fakePool() {
  const handle: any = {
    savepoint: (fn: (sp: any) => Promise<unknown>) =>
      Promise.resolve().then(() => fn(handle)),
  };
  return {
    handle,
    begin: (fn: (tx: any) => Promise<unknown>) =>
      Promise.resolve().then(() => fn(handle)),
  } as any;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an event that does not declare afterCommit", () => {
  test("dispatches inside a transaction exactly as it does outside one", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("IssueReceipt", OrderPaid, () => void ran.push("receipt")),
    ]);

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        await OrderPaid.dispatchAndWait(7);
        // Unchanged from iterations 1 and 2, deliberately: opting in is what
        // moves a dispatch, and ambient state never should.
        expect(ran).toEqual(["receipt"]);
      }),
    );
  });
});

describe("an afterCommit event with no transaction open", () => {
  test("dispatches immediately, because there is nothing to wait for", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => void ran.push("mail")),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );

    expect(ran).toEqual(["mail"]);
  });
});

describe("an afterCommit event inside a transaction", () => {
  test("runs its listeners when the transaction commits, and not before", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => void ran.push("mail")),
    ]);

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        UserRegistered.dispatch(7, "ada@example.com");
        await tick();
        expect(ran).toEqual([]);
      }),
    );

    expect(ran).toEqual(["mail"]);
  });

  test("runs nothing when the transaction rolls back", async () => {
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => void ran.push("mail")),
    ]);

    await expect(
      kernelContext.run(application, () =>
        withTransaction(fakePool(), async () => {
          UserRegistered.dispatch(7, "ada@example.com");
          throw new Error("billing declined");
        }),
      ),
    ).rejects.toThrow("billing declined");
    await tick();

    // The whole feature: a user who does not exist has not been welcomed.
    expect(ran).toEqual([]);
  });

  /**
   * Invariant 4 says a sync listener joins the ambient transaction. A deferred
   * one is the exception that proves it — the transaction it was dispatched in
   * is over by the time it runs, so the listener has to be somewhere else, and
   * Bun's handle staying callable after the commit means "somewhere else" would
   * otherwise be "on the pool, silently".
   */
  test("its listener runs outside the transaction that deferred it", async () => {
    let handle: unknown = "unset";
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => {
        handle = currentTransaction();
      }),
    ]);

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        UserRegistered.dispatch(7, "ada@example.com");
      }),
    );

    expect(handle).toBeUndefined();
  });

  test("a listener that throws does not fail the committed transaction", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => {
        throw new Error("smtp is down");
      }),
      listener("WriteAuditRow", UserRegistered, () => void ran.push("audit")),
    ]);

    await expect(
      kernelContext.run(application, () =>
        withTransaction(fakePool(), async () => {
          UserRegistered.dispatch(7, "ada@example.com");
        }),
      ),
    ).resolves.toBeUndefined();

    // Invariant 3 across the commit boundary, and the transaction is untouched
    // by either listener — reporting a rejection here would have the caller
    // roll back rows the database has already kept.
    expect(ran).toEqual(["audit"]);
    expect(String(vi.mocked(error).mock.calls[0]![0])).toContain(
      "SendWelcomeEmail",
    );
  });
});

/**
 * The sharp edge, and the reason the flag ships opt-in: the two features
 * compose into something neither name suggests.
 */
describe("dispatchAndWait on a deferred event", () => {
  test("resolves immediately, having run nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ran: string[] = [];
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => void ran.push("mail")),
    ]);

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        await UserRegistered.dispatchAndWait(7, "ada@example.com");
        // The `await` bought nothing. Code on the next line reading what a
        // listener wrote finds it missing, and nothing connects the two.
        expect(ran).toEqual([]);
      }),
    );

    expect(ran).toEqual(["mail"]);
  });

  test("warns once per event name, in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => {}),
    ]);

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        await UserRegistered.dispatchAndWait(7, "ada@example.com");
        await UserRegistered.dispatchAndWait(8, "grace@example.com");
      }),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn).mock.calls[0]![0])).toContain(
      "UserRegistered",
    );
    expect(String(vi.mocked(warn).mock.calls[0]![0])).toContain("afterCommit");
  });

  test("says nothing when the same event is awaited outside a transaction", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const application = await makeApp([
      listener("SendWelcomeEmail", UserRegistered, () => {}),
    ]);

    await kernelContext.run(application, () =>
      UserRegistered.dispatchAndWait(7, "ada@example.com"),
    );

    // Nothing was deferred, so the `await` did what it says. The warning is
    // about the pairing, not about the flag.
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The queue drains in-process, often synchronously from `push`, so pushing at
 * dispatch time *is* running at dispatch time. Deferring the fan-out whole —
 * rather than only its sync half — is what keeps `afterCommit` meaning the same
 * thing for a queued listener as for an inline one.
 */
describe("a queued listener under afterCommit", () => {
  test("is pushed at the commit, not at the dispatch", async () => {
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

    await kernelContext.run(application, () =>
      withTransaction(fakePool(), async () => {
        UserRegistered.dispatch(7, "ada@example.com");
        await tick();
        expect(queue.queue.size).toBe(0);
        expect(ran).toEqual([]);
      }),
    );
    await tick();

    expect(ran).toEqual(["queued"]);
  });

  test("is never pushed when the transaction rolls back", async () => {
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

    await expect(
      kernelContext.run(application, () =>
        withTransaction(fakePool(), async () => {
          UserRegistered.dispatch(7, "ada@example.com");
          throw new Error("billing declined");
        }),
      ),
    ).rejects.toThrow("billing declined");
    await tick();

    expect(queue.queue.size).toBe(0);
    expect(ran).toEqual([]);
  });
});
