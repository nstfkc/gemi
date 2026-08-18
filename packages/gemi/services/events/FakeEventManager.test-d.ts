import { describe, expectTypeOf, test } from "vitest";

import { Event } from "./Event";
import type { FakeEventManager } from "./FakeEventManager";

/**
 * The predicate's parameter, which is the only inference the fake performs and
 * the only thing about it a runtime test cannot see.
 *
 * `events.assertDispatched(UserRegistered, (e) => e.email === "…")` is the form
 * the assertions are worth having in — the alternative is reading
 * `events.dispatched[0].event` and casting — and it depends entirely on
 * `InstanceType<T>` flowing from the class argument to the callback. Widen that
 * to `Event` and every predicate in every application starts needing a cast;
 * widen it to `any` and a typo in a field name becomes a predicate that is
 * silently never true, which is an assertion that fails with the right shape of
 * message for the wrong reason.
 *
 * Types only: the file never constructs a manager, because `Event.fake()` needs
 * an application and this is a `--typecheck.only` run.
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

declare const events: FakeEventManager;

describe("the assertions' predicate", () => {
  test("receives the instance of the class it was passed", () => {
    events.assertDispatched(UserRegistered, (event) => {
      expectTypeOf(event).toEqualTypeOf<UserRegistered>();
      expectTypeOf(event.email).toEqualTypeOf<string>();
      expectTypeOf(event).not.toBeAny();
      return true;
    });
  });

  test("is inferred the same way on every assertion that takes one", () => {
    events.assertNotDispatched(UserRegistered, (event) => {
      expectTypeOf(event.userId).toEqualTypeOf<number>();
      return true;
    });

    events.assertDispatchedTimes(UserRegistered, 1, (event) => {
      expectTypeOf(event.userId).toEqualTypeOf<number>();
      return true;
    });
  });

  test("rejects a field the event does not have", () => {
    events.assertDispatched(UserRegistered, (event) =>
      // @ts-expect-error - UserRegistered has no `orderId`
      Boolean(event.orderId),
    );
  });
});

describe("the recorder", () => {
  test("hands back what was dispatched, typed as an Event", () => {
    expectTypeOf(events.dispatched[0]!.event).toEqualTypeOf<Event>();
    expectTypeOf(events.dispatched[0]!.args).toEqualTypeOf<
      readonly unknown[] | undefined
    >();
  });
});
