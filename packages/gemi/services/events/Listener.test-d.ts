import { describe, expectTypeOf, test } from "vitest";

import { Event } from "./Event";
import { Listener } from "./Listener";

/**
 * The two things the compiler enforces about a listener, and only those two.
 *
 * The binding between `static event` and the annotation on `handle` is *not*
 * one of them — a static and an instance member cannot reference each other's
 * types, so nothing here can check that a listener declaring
 * `static event = UserRegistered` handles a `UserRegistered`. That seam is
 * accepted, and documented on `Listener` itself.
 *
 * What is left is worth pinning precisely because it is small and load-bearing.
 * Both halves are one convenience away from being widened into `any`: typing
 * `static event` loosely would let a listener bind to something that is not an
 * event and register under a name nothing dispatches, and the bivariance below
 * is what the whole no-generic design rests on — if a `strictFunctionTypes`
 * -adjacent change ever stopped method parameters being bivariant, every
 * listener in every application would stop compiling at once, and it would be
 * this file that said why.
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

describe("the event a listener binds to", () => {
  test("keeps its own type, so the class is readable off the static", () => {
    class SendWelcomeEmail extends Listener {
      static name = "SendWelcomeEmail";
      static event = UserRegistered;

      handle() {}
    }

    expectTypeOf(SendWelcomeEmail.event).toEqualTypeOf<typeof UserRegistered>();
    expectTypeOf(SendWelcomeEmail.event).not.toBeAny();
  });

  test("has to be an Event subclass", () => {
    class NotAnEvent {
      userId = 1;
    }

    // The error lands on the class, not on the assignment: an incompatible
    // static is reported as "class static side incorrectly extends base class
    // static side", which is a property of the declaration as a whole.
    // @ts-expect-error - NotAnEvent does not extend Event
    class Broken extends Listener {
      static event = NotAnEvent;

      handle() {}
    }

    expectTypeOf(Broken).not.toBeAny();
  });
});

describe("handle", () => {
  /**
   * The bivariance the no-generic design leans on. `Listener` annotates
   * `handle(event: Event)`; a subclass narrowing that parameter to the one
   * event it binds to is what gives application code a typed payload without a
   * `Listener<UserRegistered>` generic to carry around.
   */
  test("may narrow the base's Event parameter to one event", () => {
    class SendWelcomeEmail extends Listener {
      static name = "SendWelcomeEmail";
      static event = UserRegistered;

      handle(event: UserRegistered) {
        expectTypeOf(event.email).toEqualTypeOf<string>();
        expectTypeOf(event.userId).toEqualTypeOf<number>();
        expectTypeOf(event).not.toBeAny();
      }
    }

    expectTypeOf<
      Parameters<SendWelcomeEmail["handle"]>[0]
    >().toEqualTypeOf<UserRegistered>();
  });

  test("may take nothing, and may be async", () => {
    class Ignores extends Listener {
      static name = "Ignores";
      static event = UserRegistered;

      async handle() {}
    }

    expectTypeOf<ReturnType<Ignores["handle"]>>().toEqualTypeOf<
      Promise<void>
    >();
  });
});
