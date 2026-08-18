import { describe, expect, test } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { Repository } from "../../support/Repository";
import { Event } from "./Event";
import { EventServiceProvider } from "./EventServiceProvider";
import { Listener, type ListenerClass } from "./Listener";

/**
 * The class side, which is the only half an application ever calls.
 *
 * Everything in `EventManager.test.ts` reaches the manager directly, and a
 * manager that works says nothing about whether `UserRegistered.dispatch(...)`
 * reaches it. Three things live only here and are silent when broken: the
 * container lookup (a `dispatch` bound to the wrong token, or to a manager
 * captured at module scope rather than resolved per context, fires into
 * nothing), the argument forwarding (a dropped spread builds an event whose
 * payload fields are all `undefined`, and every listener still runs), and
 * `refuseUnnamed`. None of them fails loudly, and none of them is covered by a
 * test that constructs the event itself.
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

/** A listener that records what `handle` received, in `seen`. */
function listener(seen: UserRegistered[]) {
  return class SendWelcomeEmail extends Listener {
    static name = "SendWelcomeEmail";
    static event = UserRegistered;

    handle(event: UserRegistered) {
      seen.push(event);
    }
  };
}

/**
 * An application holding nothing but the events provider, with its listeners
 * declared rather than discovered — `register()` alone binds the manager, so
 * there is no directory to walk and no boot to wait for.
 */
function makeApp(listeners: ListenerClass[] = []) {
  const application = new Application(new Repository({ events: { listeners } }));
  application.register(EventServiceProvider);
  return application;
}

describe("dispatching from the class", () => {
  test("resolves the manager out of the current application and runs its listeners", async () => {
    const seen: UserRegistered[] = [];
    const application = makeApp([listener(seen)]);

    kernelContext.run(application, () =>
      UserRegistered.dispatch(7, "ada@example.com"),
    );
    // `dispatch` returns before its listeners have; one turn is enough for a
    // synchronous handle, and the assertion is about what it was handed.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toHaveLength(1);
    // The constructor's arguments, forwarded through `ConstructorParameters`.
    // A dropped spread leaves both of these `undefined` and the listener still
    // runs, so this is the assertion that sees it.
    expect(seen[0]!.userId).toBe(7);
    expect(seen[0]!.email).toBe("ada@example.com");
  });

  test("reads the application from the context it was called in, not one captured earlier", async () => {
    const first: UserRegistered[] = [];
    const second: UserRegistered[] = [];
    const one = makeApp([listener(first)]);
    const other = makeApp([listener(second)]);

    await kernelContext.run(one, () =>
      UserRegistered.dispatchAndWait(1, "a@example.com"),
    );
    await kernelContext.run(other, () =>
      UserRegistered.dispatchAndWait(2, "b@example.com"),
    );

    expect(first.map((event) => event.userId)).toEqual([1]);
    expect(second.map((event) => event.userId)).toEqual([2]);
  });

  test("dispatchAndWait does not resolve until the listeners have", async () => {
    let release!: () => void;
    const settled: string[] = [];

    class SlowListener extends Listener {
      static name = "SlowListener";
      static event = UserRegistered;

      handle() {
        return new Promise<void>((resolve) => {
          release = () => {
            settled.push("listener");
            resolve();
          };
        });
      }
    }

    const application = makeApp([SlowListener]);

    const waiting = kernelContext
      .run(application, () => UserRegistered.dispatchAndWait(1, "a@x.com"))
      .then(() => settled.push("caller"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual([]);

    release();
    await waiting;
    expect(settled).toEqual(["listener", "caller"]);
  });
});

/**
 * The cheap half of invariant 1: an event whose name is not a name cannot be
 * routed, so it is refused rather than dispatched into a registry that has no
 * key for it. The refusal happens before the container is touched, which is why
 * these run without an application around them.
 */
describe("dispatching an event with no name", () => {
  /** The base, still holding the inherited `"unset"`. */
  const unnamed = Event as unknown as {
    dispatch(): void;
    dispatchAndWait(): Promise<void>;
  };

  /**
   * A class expression returned rather than bound, so nothing names it. Any
   * binding — `const X = class …`, an object property, `export default` —
   * would, which is why this has to be built out of reach of one.
   */
  const anonymous = () =>
    (class extends Event {}) as unknown as { dispatch(): void };

  test("refuses the base itself", () => {
    expect(() => unnamed.dispatch()).toThrow(
      "Cannot dispatch an event with no name",
    );
  });

  test("refuses an anonymous class, whose own name is the empty string", () => {
    // Not the inherited `"unset"`: a class expression with no binding to take a
    // name from gets an own, non-writable `name` of `""`. Checking `"unset"`
    // alone would let this dispatch under the key `""` and surface as an
    // ordinary event nobody happens to be listening for.
    expect(Object.getOwnPropertyDescriptor(anonymous(), "name")?.value).toBe("");

    expect(() => anonymous().dispatch()).toThrow(
      "Cannot dispatch an event with no name",
    );
  });

  test("refuses dispatchAndWait on the same terms, and before it returns a promise", () => {
    expect(() => unnamed.dispatchAndWait()).toThrow(
      "Cannot dispatch an event with no name",
    );
  });
});
