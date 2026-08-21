import { afterEach, describe, expect, test, vi } from "vitest";

import { Event } from "./Event";
import { EventManager } from "./EventManager";
import { Listener } from "./Listener";

/**
 * Fan-out, and the three ways it goes quiet.
 *
 * Every failure this file guards is silent by nature. A dispatch nothing is
 * registered for is legal; a listener that throws takes its own side effect
 * with it and nothing else; a listener the registry refused is a file the
 * author wrote that never runs. None of them raises anything a caller can see,
 * which is why the assertions are on the console and on the registry rather
 * than on a return value — `dispatch` returns `void` and `dispatchAndWait`
 * resolves either way, deliberately.
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
}

/** A listener whose `handle` is observable through the spy it is built with. */
function listener(
  name: string,
  handle: (event: any) => void | Promise<void>,
  event = UserRegistered,
) {
  return {
    [name]: class extends Listener {
      static name = name;
      static event = event;
      handle(received: UserRegistered) {
        return handle(received);
      }
    },
  }[name]!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dispatch with listeners", () => {
  test("runs every one of them, on the instance the arguments built", async () => {
    const seen: Array<[string, UserRegistered]> = [];
    const manager = new EventManager({
      listeners: [
        listener(
          "SendWelcomeEmail",
          (event) => void seen.push(["mail", event]),
        ),
        listener("NotifyAdmins", (event) => void seen.push(["admins", event])),
      ],
    });

    const event = new UserRegistered(7, "ada@example.com");
    await manager.dispatchAndWait(event);

    expect(seen.map(([who]) => who)).toEqual(["mail", "admins"]);
    // The same instance reaches both — an event is a payload, and nothing
    // clones or serialises it on the way to a sync listener.
    expect(seen.every(([, received]) => received === event)).toBe(true);
    expect(seen[0]![1].userId).toBe(7);
    expect(seen[0]![1].email).toBe("ada@example.com");
  });

  test("only the listeners bound to that event", async () => {
    const ran: string[] = [];
    const manager = new EventManager({
      listeners: [
        listener("SendWelcomeEmail", () => void ran.push("SendWelcomeEmail")),
        listener(
          "IssueReceipt",
          () => void ran.push("IssueReceipt"),
          OrderPaid,
        ),
      ],
    });

    await manager.dispatchAndWait(new UserRegistered(1, "a@example.com"));

    expect(ran).toEqual(["SendWelcomeEmail"]);
  });
});

/**
 * Invariant 3, and the one a refactor breaks.
 *
 * Listeners are independent side effects, and their order comes from a
 * filesystem walk rather than from anything an author chose — so letting
 * listener 2 cancel 3 through 5 would make that walk load-bearing, which is the
 * exact coupling the subsystem exists to remove.
 */
describe("a listener that throws", () => {
  const failing = () =>
    new EventManager({
      listeners: [
        listener("First", () => void ran.push("First")),
        listener("Middle", () => {
          throw new Error("smtp is down");
        }),
        listener("Last", () => void ran.push("Last")),
      ],
    });

  let ran: string[] = [];

  afterEach(() => {
    ran = [];
  });

  test("does not stop the listeners after it, and is logged with both names", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await failing().dispatchAndWait(new UserRegistered(1, "a@example.com"));

    expect(ran).toEqual(["First", "Last"]);

    const [message, cause] = vi.mocked(error).mock.calls[0]!;
    expect(message).toContain("Middle");
    expect(message).toContain("UserRegistered");
    expect((cause as Error).message).toBe("smtp is down");
  });

  test("does not make dispatchAndWait reject", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      failing().dispatchAndWait(new UserRegistered(1, "a@example.com")),
    ).resolves.toBeUndefined();
  });

  test("does not make the fire-and-forget dispatch reject either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      failing().dispatch(new UserRegistered(1, "a@example.com"));
      // Two turns: one for the loop's own awaits, one for a rejection that
      // would have escaped `dispatch`'s floating promise.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(ran).toEqual(["First", "Last"]);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("dispatchAndWait", () => {
  test("does not resolve until an async listener has", async () => {
    let release!: () => void;
    const settled = vi.fn();
    const manager = new EventManager({
      listeners: [
        listener(
          "SlowListener",
          () => new Promise<void>((resolve) => (release = resolve)),
        ),
      ],
    });

    const waiting = manager
      .dispatchAndWait(new UserRegistered(1, "a@example.com"))
      .then(settled);

    // Several turns, so "not settled yet" is a claim about the listener's
    // promise rather than about microtask ordering.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();

    release();
    await waiting;
    expect(settled).toHaveBeenCalled();
  });
});

/**
 * Invariant 2. The whole early-warning system for the subsystem: a registry
 * keyed by the wrong string, a name that does not survive a production build, a
 * typo, and a listener directory that was never walked all produce this one
 * symptom.
 */
describe("a dispatch nothing is listening for", () => {
  test("warns once per event name, however often it is dispatched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new EventManager({ listeners: [] });

    await manager.dispatchAndWait(new UserRegistered(1, "a@example.com"));
    await manager.dispatchAndWait(new UserRegistered(2, "b@example.com"));
    await manager.dispatchAndWait(new UserRegistered(3, "c@example.com"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(warn).mock.calls[0]![0]).toContain("UserRegistered");
  });

  test("warns again for a different event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new EventManager({ listeners: [] });

    await manager.dispatchAndWait(new UserRegistered(1, "a@example.com"));
    await manager.dispatchAndWait(new OrderPaid());

    expect(warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(warn).mock.calls[1]![0]).toContain("OrderPaid");
  });

  test("is remembered per manager, so a fresh application warns again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new EventManager().dispatchAndWait(new UserRegistered(1, "a@x.com"));
    await new EventManager().dispatchAndWait(new UserRegistered(1, "a@x.com"));

    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("says nothing in production, where zero listeners is just the answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      await new EventManager({ listeners: [] }).dispatchAndWait(
        new UserRegistered(1, "a@example.com"),
      );
    } finally {
      process.env.NODE_ENV = previous;
    }

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("what useListeners refuses", () => {
  test("a listener with no `static event`, by name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    class Unbound extends Listener {
      static name = "Unbound";
      handle() {}
    }

    // The compiler cannot see this: `static event` is declared on the base, so
    // every subclass inherits the declaration whether or not it assigns one.
    const manager = new EventManager({ listeners: [Unbound as never] });

    expect(vi.mocked(error).mock.calls[0]![0]).toContain("Unbound");
    expect(vi.mocked(error).mock.calls[0]![0]).toContain("static event");
    // Still reported as handed in, so a test can see what was refused.
    expect(manager.registeredListeners).toEqual([Unbound]);
  });

  test("a second listener claiming a name the first took", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];

    const manager = new EventManager({
      listeners: [
        listener("NotifyAdmins", () => void ran.push("auth")),
        listener("NotifyAdmins", () => void ran.push("billing")),
      ],
    });

    await manager.dispatchAndWait(new UserRegistered(1, "a@example.com"));

    expect(ran).toEqual(["auth"]);
    expect(vi.mocked(error).mock.calls[0]![0]).toContain(
      'Two event listeners are named "NotifyAdmins"',
    );
    // Both appear here — the getter reports what came in, not what the registry
    // accepted, so the clash is visible rather than tidied away.
    expect(manager.registeredListeners).toHaveLength(2);
  });
});

/**
 * The far side of the queue, where a name and an argument array have to become
 * an event again.
 *
 * This is invariant 1 at its second boundary and the first place the manager
 * has to resolve an *event* class by name. The registry it reads is built from
 * the listeners' `static event`, which is why an event nobody listens for is
 * not in it — nothing could have been queued for one.
 */
describe("rehydrating an event off the queue", () => {
  test("round-trips the constructor's arguments", () => {
    const manager = new EventManager({
      listeners: [listener("SendWelcomeEmail", () => {})],
    });

    const event = manager.rehydrate("UserRegistered", [
      7,
      "ada@example.com",
    ]) as UserRegistered;

    expect(event).toBeInstanceOf(UserRegistered);
    expect(event.userId).toBe(7);
    expect(event.email).toBe("ada@example.com");
  });

  test("throws on a name nothing is registered for, and names it", () => {
    const manager = new EventManager({
      listeners: [listener("SendWelcomeEmail", () => {})],
    });

    // The one failure in this file that is not swallowed. The payload is
    // already off the queue and the listener is a line away from being handed
    // `undefined`, so the alternative is `event.email` failing several frames
    // later with nothing left in scope to explain it.
    expect(() => manager.rehydrate("OrderPaid", [])).toThrow("OrderPaid");
  });
});

describe("the readable view", () => {
  test("is a copy, so walking it cannot edit what a dispatch runs", () => {
    const manager = new EventManager({
      listeners: [listener("SendWelcomeEmail", () => {})],
    });

    (manager.registeredListeners as unknown[]).length = 0;

    expect(manager.registeredListeners).toHaveLength(1);
  });
});
