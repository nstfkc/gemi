import type { Event, EventClass } from "./Event";

/**
 * One side effect of one event, in its own file.
 *
 * ```typescript
 * // app/listeners/SendWelcomeEmail.ts
 * export class SendWelcomeEmail extends Listener {
 *   static name = "SendWelcomeEmail";
 *   static event = UserRegistered;
 *
 *   async handle(event: UserRegistered) {
 *     await Mail.send(event.email, ...);
 *   }
 * }
 * ```
 *
 * That is the whole of what the subsystem buys: adding a fourth side effect to
 * a registration is adding a file, rather than editing the controller that
 * already has three.
 *
 * ### Why the binding lives here and not on the event
 *
 * The listener is the thing with an opinion about what it cares about; an event
 * has no business knowing who is watching. An event listing its listeners would
 * also put the property back the way it was — adding a side effect would edit
 * an existing file.
 *
 * ### Why the binding is a value at all
 *
 * Laravel binds a listener to an event by reflecting on the type-hint of
 * `handle(UserRegistered $event)`. TypeScript erases types at runtime, so that
 * mechanism cannot exist here and the binding has to be carried as a value.
 * That constraint turns out to be a favourable one: it is also what makes the
 * payload types flow without a generated registry.
 *
 * ### The seam, written down rather than hidden
 *
 * **Nothing checks that `static event` and the annotation on `handle` agree.**
 * A static and an instance member cannot reference each other's types, so the
 * compiler sees `static event = UserRegistered` and `handle(event: OrderPaid)`
 * as two unrelated declarations. Copy a listener, change the static, forget the
 * annotation, and TypeScript is satisfied while the listener receives something
 * else.
 *
 * It is accepted because the failure is local and immediate — that one listener
 * reads a field that is not there, in its own stack — rather than the
 * misroute-shaped failures the rest of this subsystem is arranged against. The
 * `Listener.test-d.ts` beside this file pins the two halves the compiler *does*
 * enforce, so a later refactor reaching for convenience cannot widen them to
 * `any` unnoticed.
 */
export abstract class Listener {
  /**
   * The name this listener is reported and de-duplicated under. Required.
   *
   * Two listener classes claiming one name is refused at registration, and a
   * discovery walk makes that ordinary: `auth/NotifyAdmins.ts` beside
   * `billing/NotifyAdmins.ts` is a natural thing to write, and nothing forces
   * the import alias a hand-written list would have demanded.
   *
   * As on `Event`, the `"unset"` default is a floor and not the check — a class
   * declaration always shadows it with its own implicit binding, which is the
   * one a minifier renames. `discoverListeners` reads the property descriptor
   * to tell a declared name from an implicit one.
   */
  static name = "unset";

  /**
   * The event class this listener handles. Exactly one, required.
   *
   * It holds the **class**, not its name. The name is read off it once, at
   * registration, inside `EventManager.useListeners` — and that read happens in
   * the module graph that declared the class, so the name it yields is the
   * source one. Nothing downstream keeps the class object, because a registry
   * keyed by class identity is wrong in production only.
   *
   * There is no `static events = [A, B]`, deliberately. A listener bound to two
   * events has to discriminate inside `handle`, and the natural way to write
   * that is `if (event instanceof UserRegistered)` — which is `true` in every
   * test and `false` in a production build, for the reason `Event`'s own doc
   * comment gives. Two events wanting the same side effect are two small
   * listeners calling one shared function.
   *
   * Declared as required, and still checked at runtime: every subclass inherits
   * this declaration whether or not it assigns to it, so the compiler cannot
   * see a listener that left it out. `EventManager` refuses one out loud.
   */
  static event: EventClass;

  /**
   * The side effect. Runs inside the dispatcher's context: a sync listener has
   * the request's `app()`, its authenticated user, and its ambient
   * transaction.
   *
   * Annotate the parameter with the event named in `static event` — narrowing
   * the base's `Event` here is legal because method parameters are bivariant,
   * which is what lets this class avoid a generic parameter. Nothing checks
   * that the two agree; see the note on the class.
   *
   * Abstract, so a listener that forgets it fails to compile rather than
   * silently handling nothing.
   *
   * A throw is caught, logged with both names, and the next listener still
   * runs. Listeners are independent side effects by construction, and their
   * order is a filesystem walk's — letting one cancel the rest would make that
   * order load-bearing, which is the exact coupling this subsystem exists to
   * remove.
   */
  abstract handle(event: Event): void | Promise<void>;
}

/**
 * A `Listener` subclass, as the registry and the `events` config slice hold
 * one.
 *
 * Zero-argument, because the manager constructs one per dispatch and has
 * nothing to pass it. The `event` member is typed as present even though
 * `EventManager` checks for it at runtime: an inherited declaration is
 * indistinguishable from an assignment to the type system, so this is the
 * shape, and the runtime check is what covers the difference.
 */
export type ListenerClass = (new () => Listener) & {
  name: string;
  event: EventClass;
};
