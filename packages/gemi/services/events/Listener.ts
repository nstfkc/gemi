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
   *
   * For a **queued** listener it is more than a label: the queue is keyed by
   * name, the listener is registered under `listener:<name>`, and that string
   * is what a queued dispatch carries. So a queued listener whose name is the
   * implicit class binding is refused at registration rather than warned about
   * — the two ends of the queue can be two different module graphs, and a name
   * only one of them minified is a side effect that stops happening in
   * production and reports success.
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
   * Where this listener runs. **A context boundary, not a performance dial.**
   *
   * Left `false`, the listener runs inline, inside the dispatcher's
   * `kernelContext` and `ormContext`: it has the request's `app()`, the
   * authenticated user through `currentActor()`, and it joins the ambient
   * transaction.
   *
   * Set `true`, it is handed to the `QueueManager` instead and run from a
   * drain, on the queue's terms. What crosses is the event's name and its
   * constructor arguments as JSON, and nothing else — not the instance the sync
   * listeners share, and not a line of the request. With `worker = true` it is
   * a different thread with a cloned application.
   *
   * The part that catches people is that the context is not reliably *gone*
   * either: the queue is in-process, so a drain that happens to start from
   * `push` is still standing in the dispatcher's context and `app()` there
   * resolves the request's application. Nothing about that is promised. A
   * queued listener that reads the current actor, or writes expecting to join
   * the ambient transaction, works until the day the queue was already busy —
   * and then reads different rows, or commits separately, with no error either
   * way. So: a listener that needs the request's context has to stay sync, and
   * a listener that only needs the payload is free to queue.
   *
   * What it buys, in exchange, is the queue's whole retry path: `maxAttempts`,
   * `onFail`-style re-queueing and dead-lettering, none of which a sync
   * listener has. `dispatchAndWait` does **not** wait for it.
   */
  queued = false;

  /**
   * Attempts before the queue gives up, counting the first. `Job`'s field and
   * `Job`'s meaning, because it is forwarded to one.
   *
   * **Ignored unless `queued` is true.** A sync listener has no retry path at
   * all — its throw is logged and the next listener runs — so a `maxAttempts`
   * beside `queued = false` is a line that does nothing, which is why it is
   * said here rather than in a note somewhere else.
   */
  maxAttempts = 3;

  /**
   * Runs `handle` in a Worker thread with its own cloned application, for a
   * queued listener whose work is CPU-bound. `Job`'s field and `Job`'s
   * meaning, because it is forwarded to one.
   *
   * **Ignored unless `queued` is true.** A sync listener runs on the
   * dispatcher's stack by definition; there is no thread to move it to.
   */
  worker = false;

  /**
   * The side effect. Runs inside the dispatcher's context when `queued` is
   * false: a sync listener has the request's `app()`, its authenticated user,
   * and its ambient transaction. A queued one can rely on none of them — see
   * `queued`.
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
