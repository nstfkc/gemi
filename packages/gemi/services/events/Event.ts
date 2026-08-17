import { app } from "../../foundation/app";
import { EventManager } from "./EventManager";

/**
 * Something the application did, addressed to nobody in particular.
 *
 * An event is the payload plus a name. It carries no framework state — no
 * timestamp, no id, no `propagationStopped` — because every one of those is a
 * field the application can declare itself if it wants one, and a listener that
 * could stop the next listener would make registration order load-bearing when
 * that order comes from a filesystem walk nobody chose.
 *
 * ```typescript
 * // app/events/UserRegistered.ts
 * export class UserRegistered extends Event {
 *   static name = "UserRegistered";
 *   constructor(
 *     public userId: number,
 *     public email: string,
 *   ) {
 *     super();
 *   }
 * }
 * ```
 *
 * ### Why `static name` is required and not a convenience
 *
 * The registry is keyed by this string, never by the class object, and that is
 * the least obvious decision in the subsystem. `gemi build` minifies the server
 * entry, and the app code reachable from it — the controller, and every event
 * class that controller imports in order to dispatch — is bundled and minified
 * with it. Discovery, meanwhile, imports `app/listeners/*.ts` from source at
 * runtime, and those files import `app/events/*.ts` from source too. Two module
 * graphs, two `UserRegistered` class objects. A map keyed by the class would
 * look up the bundled one, find the entry registered under the source one, and
 * return nothing — a dispatch with zero listeners, which is legal, normal, and
 * completely silent. It would work in development, pass every test, and do
 * nothing in production.
 *
 * A declared `static name` is a string literal and minification leaves string
 * literals alone, so both halves agree.
 *
 * The same two class objects are why **application code must never `instanceof`
 * an event**: inside a listener, `event instanceof UserRegistered` is `true` in
 * development and `false` in a production build. Nothing the framework can do
 * fixes that, so the framework's job is to never need it — which is why a
 * listener binds to exactly one event.
 */
export abstract class Event {
  /**
   * The name this event registers and dispatches under. Required.
   *
   * The `"unset"` default is the floor rather than the check: a `class
   * UserRegistered extends Event {}` shadows this with its own implicit class
   * binding, which reads `"UserRegistered"` in development and something like
   * `"D"` in a minified bundle. `discoverListeners` is what tells a declared
   * name from an implicit one — it reads the property descriptor, because both
   * spellings produce the same string right up until the build.
   */
  static name = "unset";

  /**
   * Makes `Event` nominal, and exists for nothing else.
   *
   * An event carries no framework state, so `Event`'s instance side is empty —
   * and an empty type is structurally satisfied by *everything*, which would
   * make the one constraint the compiler can enforce here vacuous:
   * `static event = SomeRandomClass` would type-check, register under a name
   * nothing dispatches, and never run. `declare` means no field is emitted and
   * no subclass has to initialise it; `protected` means only a real subclass
   * can produce a value of this type.
   */
  declare protected readonly __isEvent: true;

  /**
   * Fires the event and returns immediately. Every sync listener bound to it
   * runs; none of them can report anything back here.
   *
   * The arguments are the event's constructor arguments, typed through
   * `ConstructorParameters` — the same trick `Job.dispatch` plays through
   * `Parameters<T["run"]>`, so the two subsystems read the same way at the call
   * site.
   *
   * ```typescript
   * const user = await User.create(input);
   * UserRegistered.dispatch(user.id, user.email);
   * ```
   *
   * A listener that throws is logged and the next one still runs, so nothing
   * here can fail on a listener's behalf. A dispatch that nothing is listening
   * for is legal and warns once, in development only.
   */
  static dispatch<T extends EventClass>(
    this: T,
    ...args: ConstructorParameters<T>
  ): void {
    refuseUnnamed(this);
    app(EventManager).dispatch(new this(...args));
  }

  /**
   * Fires the event and resolves once every **sync** listener has settled.
   *
   * It does not wait for a queued listener, which by construction runs in a
   * cloned application after this promise has resolved — "and wait" invites
   * exactly that reading, so it is written down here rather than left to be
   * discovered by a test that passes locally.
   *
   * Two methods rather than one `dispatch` that is sometimes worth awaiting,
   * because "is this worth awaiting" is a question the call site should not
   * have to guess at. This one is for a caller that genuinely needs the side
   * effects to have happened before it continues — a request that renders what
   * a listener wrote, a test asserting on the result.
   *
   * Never rejects. A listener's failure is that listener's, and letting it
   * surface here would mean listener 1's throw becomes the caller's problem
   * while listener 5's does not, depending only on where in a filesystem walk
   * the throw landed.
   */
  static dispatchAndWait<T extends EventClass>(
    this: T,
    ...args: ConstructorParameters<T>
  ): Promise<void> {
    refuseUnnamed(this);
    return app(EventManager).dispatchAndWait(new this(...args));
  }
}

/**
 * Stops a dispatch that could not be routed anywhere.
 *
 * Two values reach it and neither is a name a listener could have registered
 * under. `"unset"` is the inherited default, which only the base itself still
 * has — a class *declaration* always shadows it with its own binding. `""` is
 * what an anonymous class expression with no binding to take a name from gets:
 * an own, non-writable `name` of the empty string rather than the inherited
 * default, so checking `"unset"` alone would let `(class extends Event {})`
 * through to dispatch under the key `""` and surface as the generic
 * zero-listener warning instead of the message that names the fix.
 *
 * A throw rather than a warning because there is no listener that could be
 * registered under either, so the alternative is a dispatch that silently does
 * nothing. This is only the floor: a declared `static name` and the implicit
 * class binding are indistinguishable by value here, and `discoverListeners`
 * reading the property descriptor is what tells those two apart.
 */
function refuseUnnamed(event: EventClass): void {
  if (event.name !== "unset" && event.name !== "") return;

  throw new Error(
    `Cannot dispatch an event with no name. Add \`static name\` to this Event ` +
      `subclass — the listener registry is keyed by that string, and by that ` +
      `string alone, so an event without one cannot reach a listener.`,
  );
}

/**
 * An `Event` subclass, as `Listener.event` holds one and as `dispatch` narrows
 * `this` to.
 *
 * Concrete rather than `abstract new`, because the only thing anyone does with
 * one of these is construct it: a listener bound to an abstract event would
 * register under a name nothing can ever dispatch.
 */
export type EventClass = new (...args: any[]) => Event;
