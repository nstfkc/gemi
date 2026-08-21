import type { Application } from "../../foundation/Application";
import type { Event, EventClass } from "./Event";
import { EventManager } from "./EventManager";

/**
 * One dispatch, as a fake saw it.
 *
 * Both halves are kept because neither is derivable from the other. The
 * instance is what a predicate reads — `(e) => e.email === "…"` — and the
 * arguments are what the failure message can print, because an instance cannot
 * be asked what it was constructed with. A dispatch made straight at the
 * manager carries no arguments at all, which is why they are optional here in
 * exactly the way they are on `dispatch`.
 */
export interface DispatchedEvent {
  event: Event;
  args?: readonly unknown[];
}

/**
 * An `EventManager` that records dispatches and runs nothing.
 *
 * Installed by `Event.fake()`, which is the only thing that constructs one —
 * see there for what a fake is for and why `restore()` is not optional.
 *
 * It extends the real manager rather than reimplementing its shape, so a test
 * holding one can still ask `registeredListeners` and get the honest answer
 * (empty: a fake registers none). What it overrides is the two dispatch entry
 * points, and everything downstream of them is unreachable as a result — no
 * listener is constructed, no `handle` runs, nothing is pushed to the
 * `QueueManager`, and no `afterCommit` event is queued on the open transaction.
 * That last one is worth stating: a fake short-circuits *before* the
 * transaction check, so a faked dispatch is recorded at the moment it is made
 * whether or not the event defers, and a test does not have to commit a
 * transaction to see it.
 *
 * The assertions throw plain `Error`s rather than going through a matcher, so
 * this file depends on no test runner. Their messages name **what was
 * dispatched**, because the common failure is not "nothing fired" but "that
 * fired with a different payload", and printing the recorded dispatches ends
 * that investigation where it starts.
 */
export class FakeEventManager extends EventManager {
  /**
   * Every dispatch since the fake was installed, in order. Public and readable
   * for the case the assertions do not cover — the last resort, rather than the
   * intended surface.
   */
  readonly dispatched: DispatchedEvent[] = [];

  /**
   * Installs a fake into `application`'s container, or returns the one already
   * there.
   *
   * A second call returning the same recorder is the deliberate half: a fake
   * set up by a shared test helper and a `Event.fake()` in the body of the test
   * would otherwise be two recorders, and the one being asserted on would be
   * the one that saw nothing. It is also why this is a static rather than a
   * constructor — "make me one" and "make sure there is one" are different
   * requests, and only the second is ever wanted.
   *
   * `resolved` rather than `make`: asking the container for the real manager
   * merely to find out whether it exists would *build* it, and building it is
   * what `restore()` then has to put back. The lazily-bound singleton stays
   * lazy, and an application that never resolved an `EventManager` is left with
   * one it never resolved.
   *
   * `instanceof` is safe here and nowhere else in this subsystem: the only
   * thing that puts a `FakeEventManager` in a container is this method, so both
   * sides of the comparison come from one module graph. The registry keys next
   * door cannot make that assumption, because the dispatching code may have
   * been bundled and minified separately from the listeners.
   */
  static install(application: Application): FakeEventManager {
    const current = application.resolved(EventManager)
      ? application.make(EventManager)
      : undefined;

    if (current instanceof FakeEventManager) return current;

    const fake = new FakeEventManager(application, current);
    application.instance(EventManager, fake);
    return fake;
  }

  private constructor(
    private readonly application: Application,
    private readonly previous: EventManager | undefined,
  ) {
    // Declared, and declared empty: `EventManager` treats a present `listeners`
    // as the app having said so, which is exactly what a fake means. Nothing
    // would run anyway — the overrides below never reach the registry — but a
    // fake that had *discovered* listeners would construct every one of them,
    // and a listener's constructor is application code.
    super({ listeners: [] });
  }

  /** Records the dispatch. No listener runs, and nothing reaches the queue. */
  override dispatch(event: Event, args?: readonly unknown[]): void {
    this.dispatched.push({ event, args });
  }

  /**
   * Records the dispatch and resolves. Resolved rather than rejected-on-nothing
   * for the same reason the real one never rejects: a caller awaiting a
   * dispatch is awaiting side effects it does not name, and under a fake there
   * are none to fail.
   */
  override async dispatchAndWait(
    event: Event,
    args?: readonly unknown[],
  ): Promise<void> {
    this.dispatched.push({ event, args });
  }

  /**
   * Puts the container back the way it was found.
   *
   * Restoring the *previous* instance rather than forgetting unconditionally:
   * an application that had already resolved its `EventManager` — one that
   * booted, discovered listeners and registered synthetic jobs with the queue —
   * must get that same object back, not a second one built from the config
   * slice with an empty registry and no jobs behind it.
   *
   * When there was none, the binding is forgotten instead, so the container's
   * lazy singleton factory builds the real manager on next use.
   *
   * Calling it twice is harmless. Not calling it is the failure this method
   * exists for: the fake stays in the container for every test after this one,
   * and every listener in them silently does not run.
   */
  restore(): void {
    if (this.previous) {
      this.application.instance(EventManager, this.previous);
      return;
    }
    this.application.forget(EventManager);
  }

  /**
   * Fails unless the event was dispatched at least once, optionally matching a
   * predicate.
   *
   * The predicate takes the event instance and is typed off the class passed
   * in, so `(e) => e.email` is checked against `UserRegistered` without a cast.
   *
   * Matched **by declared name**, never by class identity — the rule the whole
   * subsystem is keyed on. A test importing its event from the same file as the
   * code under test would not notice the difference; one asserting against a
   * production build's bundled class would find `instanceof` false and this
   * true, and this is the one that is right.
   */
  assertDispatched<T extends EventClass>(
    event: T,
    predicate?: (event: InstanceType<T>) => boolean,
  ): void {
    const name = nameOf(event);
    if (this.matching(name, predicate).length > 0) return;

    throw new Error(
      `Expected ${name}${predicate ? " matching the predicate" : ""} to have ` +
        `been dispatched. ${this.summary(name, predicate !== undefined)}`,
    );
  }

  /**
   * Fails if the event was dispatched at all, or — with a predicate — if any
   * dispatch of it matched.
   *
   * The predicate form is the useful one: "a welcome email is not sent to an
   * invited user" is an assertion about one dispatch among several, and
   * asserting the event never fired at all would be a stronger claim than the
   * test means.
   */
  assertNotDispatched<T extends EventClass>(
    event: T,
    predicate?: (event: InstanceType<T>) => boolean,
  ): void {
    const name = nameOf(event);
    const matches = this.matching(name, predicate);
    if (matches.length === 0) return;

    throw new Error(
      `Expected ${name}${predicate ? " matching the predicate" : ""} not to ` +
        `have been dispatched, but it was dispatched ${count(matches.length)}: ` +
        `${describeAll(matches)}.`,
    );
  }

  /**
   * Fails unless the event was dispatched exactly `times` times.
   *
   * Worth having beside `assertDispatched` because the failure it catches is
   * the one that assertion cannot see: a dispatch that moved inside a loop, or
   * a controller that fires the same event on both branches of a retry. "At
   * least once" passes for all of those.
   */
  assertDispatchedTimes<T extends EventClass>(
    event: T,
    times: number,
    predicate?: (event: InstanceType<T>) => boolean,
  ): void {
    const name = nameOf(event);
    const matches = this.matching(name, predicate);
    if (matches.length === times) return;

    throw new Error(
      `Expected ${name}${predicate ? " matching the predicate" : ""} to have ` +
        `been dispatched ${count(times)}, but it was dispatched ` +
        `${count(matches.length)}. ${this.summary(name, predicate !== undefined)}`,
    );
  }

  /**
   * Fails if anything at all was dispatched.
   *
   * The assertion for a path that should be inert — a request rejected by
   * validation, an idempotent write that found nothing to do — where naming the
   * events not to expect would mean listing every event the app has.
   */
  assertNothingDispatched(): void {
    if (this.dispatched.length === 0) return;

    const dispatched = this.dispatched.length;

    throw new Error(
      `Expected nothing to have been dispatched, but ${dispatched} ` +
        `${dispatched === 1 ? "event was" : "events were"}: ` +
        `${describeAll(this.dispatched)}.`,
    );
  }

  /** Recorded dispatches of `name`, narrowed by `predicate` when there is one. */
  private matching(
    name: string,
    predicate?: (event: never) => boolean,
  ): DispatchedEvent[] {
    return this.dispatched.filter(
      (record) =>
        nameOf(record.event.constructor) === name &&
        (predicate === undefined || predicate(record.event as never)),
    );
  }

  /**
   * The tail of a failure message: what *was* dispatched.
   *
   * Three cases, because they send the reader to three different places. An
   * empty recorder means the code under test dispatched nothing — look at the
   * controller. Dispatches of the same name that failed a predicate means the
   * payload is not what the test expected, and printing them is usually the
   * whole answer. Anything else means the wrong event, or none.
   */
  private summary(name: string, hadPredicate: boolean): string {
    if (this.dispatched.length === 0) return "Nothing was dispatched.";

    const sameName = this.matching(name);
    if (hadPredicate && sameName.length > 0) {
      return `Dispatched ${name}: ${describeAll(sameName)}.`;
    }

    return `Dispatched: ${describeAll(this.dispatched)}.`;
  }
}

/**
 * The declared name of an event or its class.
 *
 * A structural read rather than `EventClass["name"]`, because the same function
 * is pointed at `record.event.constructor`, which is typed `Function`.
 */
function nameOf(event: unknown): string {
  return (event as { name: string }).name;
}

/** `1 time` / `3 times`, so a message does not have to say "1 time(s)". */
function count(times: number): string {
  return `${times} ${times === 1 ? "time" : "times"}`;
}

function describeAll(records: DispatchedEvent[]): string {
  return records.map(describe).join(", ");
}

/**
 * One recorded dispatch, as `UserRegistered(7, "ada@example.com")`.
 *
 * The constructor arguments when they were carried, and the instance's own
 * fields when they were not — a dispatch made straight at the manager has no
 * arguments, and an event printed as `UserRegistered()` when it plainly held a
 * payload reads as a framework bug rather than as a test that took a shortcut.
 *
 * Everything here runs only on the way to a thrown assertion, so it is allowed
 * to be slow and must not itself throw: a circular payload rendering as a
 * TypeError would replace the failure the reader came for with one of its own.
 */
function describe(record: DispatchedEvent): string {
  const name = nameOf(record.event.constructor);
  const values = record.args ?? Object.values({ ...record.event });
  return `${name}(${values.map(inspect).join(", ")})`;
}

function inspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
