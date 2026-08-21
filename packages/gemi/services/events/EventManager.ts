import { app } from "../../foundation/app";
import { deferUntilCommit } from "../../orm/context";
import { withDefaults } from "../../support/withDefaults";
import type { Job } from "../queue/Job";
import { QueueManager } from "../queue/QueueManager";
import { eventConfigDefaults, type EventConfig } from "./config";
import type { Event, EventClass } from "./Event";
import { jobForListener } from "./listenerJob";
import type { ListenerClass } from "./Listener";

/**
 * One listener, and where it runs.
 *
 * `queued` is an instance field, so answering "does this one go on the queue?"
 * means constructing the listener — done once here, at registration, rather
 * than once per dispatch. The synthetic job is built at the same moment for the
 * same reason: `EventServiceProvider.boot()` has to hand it to the queue before
 * the first dispatch, and a job built per dispatch would be a different class
 * object each time under the same registry key.
 */
type Registration = {
  listener: ListenerClass;
  /** The job a queued listener is pushed as, or `null` when it runs inline. */
  job: (new () => Job) | null;
};

/**
 * The registry a dispatch fans out through: event name -> the listeners bound
 * to it.
 *
 * Shaped after `QueueManager` deliberately — constructed in `register()` from
 * whatever the config slice declared, handed the discovered set in `boot()`,
 * and reporting through a `registered*` getter what it was *given* rather than
 * what it accepted, so a test can see a collision instead of having it tidied
 * away.
 *
 * Three things are not `QueueManager`'s, and each is a decision rather than a
 * detail:
 *
 * **Many listeners per key.** Two listeners for one event is the normal case
 * here, where two jobs for one name is the pathological one. So the map holds
 * arrays and `useListeners` appends. The collision it does refuse is two
 * *listener classes* claiming one `static name`.
 *
 * **Registration order is the walk's order, and means nothing.** It is stable —
 * `discoverClasses` sorts per directory and the module namespace sorts by name
 * — so it is reproducible, but no listener may depend on running before
 * another, because nothing about a filesystem layout was chosen to express
 * that. What makes it safe to say is the rule below: nothing a listener does
 * can stop the next one.
 *
 * **A dispatch nobody handles warns.** That is the entire early-warning system
 * for the subsystem, and it is why it is not optional; see `dispatchAndWait`.
 *
 * A `queued` listener is not run here at all. It is registered with the
 * `QueueManager` as a synthetic job and pushed to it on dispatch, so retries,
 * `maxAttempts`, dead-lettering and worker threads are the queue's rather than
 * a second implementation of the queue's — and nothing the request had (the
 * current actor, the ambient transaction) is still promised by the time it
 * runs. See `Listener.queued`.
 *
 * **A dispatch does not always fan out at the dispatch.** An event declaring
 * `static afterCommit` has the whole of it — queued listeners included — held
 * on the ORM's transaction scope and drained when that transaction commits, or
 * dropped when it rolls back. That is the only thing in this file that reads
 * ambient state, and `deferToCommit` is where it happens.
 */
export class EventManager {
  static token = "events";

  /** Event name -> every listener bound to it, in registration order. */
  private listeners: Record<string, Registration[]> = {};

  /**
   * Event name -> the class to rebuild it from, for a listener coming back off
   * the queue.
   *
   * Read from each listener's `static event` at registration, which is the one
   * place in the subsystem an event class is dereferenced. An event nobody
   * listens for is never in here, and that is exactly right: nothing can have
   * been queued for it.
   */
  private events: Record<string, EventClass> = {};

  /**
   * Event names already warned about. Per-manager, and the manager is per
   * application, so a test that builds a fresh kernel gets a fresh set.
   */
  private warnedFor = new Set<string>();

  /**
   * Event names already warned about for the `dispatchAndWait` + `afterCommit`
   * pairing. A second set rather than a second entry in the one above: the two
   * warnings are about different mistakes, and sharing the set would mean a
   * dispatch that legitimately has no listeners silences the one that says a
   * caller is awaiting nothing.
   */
  private warnedAboutWaiting = new Set<string>();

  readonly config: Required<EventConfig>;

  constructor(config: EventConfig = {}) {
    this.config = withDefaults(eventConfigDefaults(), config);
    this.useListeners(this.config.listeners);
  }

  /**
   * Replaces the registered set, for the provider to hand over what it found
   * under `app/listeners`.
   *
   * Two phases, for the reason `QueueManager.useJobs` documents: the manager is
   * constructed in `register()`, which is synchronous and must resolve nothing,
   * while reading a directory and importing what is in it is neither. So the
   * manager is built from whatever the config slice declared — nothing, when
   * the app left `listeners` out — and the discovered set arrives in `boot()`.
   *
   * The consequence worth knowing: anything that constructs an application and
   * skips phase two dispatches into an empty registry, and an empty registry is
   * a legal steady state rather than an error. The development-only warning
   * below is the only thing that says so.
   *
   * Every listener is **constructed once here**, to read the fields that decide
   * where it runs — `queued`, and through it `maxAttempts` and `worker`. A
   * listener's constructor therefore runs at boot as well as on every dispatch,
   * so it wants to assign fields and nothing else. A queued one also has its
   * synthetic job built here; `EventServiceProvider` hands those to the queue
   * once boot reaches it, so calling this again *after* boot would leave the
   * queue holding jobs for listeners this registry no longer has.
   */
  useListeners(listeners: ListenerClass[]) {
    this.config.listeners = listeners;

    this.listeners = {};
    this.events = {};
    const claimed = new Set<string>();

    for (const listener of listeners) {
      // Declared as required on the base class and still checked here: every
      // subclass inherits the declaration whether or not it assigns to it, so
      // `typeof SomeListener` satisfies `ListenerClass` either way and the
      // compiler cannot see the omission. Refused rather than registered under
      // some fallback, because there is no fallback — a listener with no event
      // is a file the author wrote that nothing will ever call.
      if (!listener.event) {
        console.error(
          `Listener ${listener.name} does not declare \`static event\`, so ` +
            `there is no event name to register it under and its handle will ` +
            `never run. Add: static event = SomeEvent;`,
        );
        continue;
      }

      // Two classes with one name, refused here and nowhere else — which is
      // what keeps the queue from being handed two jobs called
      // `listener:NotifyAdmins` and having to decide between them one layer
      // down, where the loser is a side effect that reports success. A
      // directory walk is what makes the clash ordinary, since nothing forces
      // the import alias a hand-written list would have demanded.
      if (claimed.has(listener.name)) {
        console.error(
          `Two event listeners are named "${listener.name}" — the first is ` +
            `registered and this one is not. A listener's name identifies it ` +
            `across the framework, so only one class can hold it. Rename one.`,
        );
        continue;
      }
      claimed.add(listener.name);

      // The one place the event class is dereferenced, and deliberately the
      // only one: this runs in the module graph that declared the class, so the
      // name it yields is the source-side one that discovery and a minified
      // dispatcher both agree on. Nothing downstream keeps the class object —
      // except `this.events`, which keeps it under that same string so a
      // listener coming back off the queue has something to rebuild from. First
      // claim wins there too: a name is what identifies an event to everything
      // downstream, so two classes declaring one are one event already.
      const name = listener.event.name;
      const instance = new listener();

      this.events[name] ??= listener.event;
      (this.listeners[name] ??= []).push({
        listener,
        job: instance.queued ? jobForListener(listener, instance) : null,
      });
    }
  }

  /**
   * The synthetic jobs the queue has to be told about — one per queued
   * listener, named `listener:<name>`.
   *
   * `EventServiceProvider.boot()` is the only caller. It reads this rather than
   * having the manager reach for the `QueueManager` itself, because
   * registration happens in `register()`, where resolving another service is
   * exactly what a provider must not do. A copy, so the caller cannot edit what
   * a dispatch pushes.
   */
  get queuedListenerJobs(): ReadonlyArray<new () => Job> {
    return Object.values(this.listeners)
      .flat()
      .flatMap(({ job }) => (job ? [job] : []));
  }

  /**
   * What the manager was handed, discovered or declared.
   *
   * "Is this listener registered?" is a question with a silent wrong answer —
   * an unregistered listener is a side effect that does not happen, and nothing
   * is waiting on it to notice. This is where a test asks it out loud.
   *
   * It reports what came in, not what the registry accepted, so a name claimed
   * twice appears twice here — deliberately, the same way `QueueManager` and
   * `Scheduler` do. A copy, so a walk over it cannot edit what dispatch reads.
   */
  get registeredListeners(): ReadonlyArray<ListenerClass> {
    return [...this.config.listeners];
  }

  /**
   * Fires the event and returns. The sync listeners run to completion after the
   * caller has moved on.
   *
   * Nothing is awaited and nothing can reject: `runListeners` catches every
   * listener's failure itself, so the floating promise here has no rejection to
   * float.
   *
   * `args` is the event's constructor arguments; see `dispatchAndWait`.
   *
   * On an `afterCommit` event inside a transaction, "after the caller has moved
   * on" becomes "after that transaction commits" — see `deferToCommit`.
   */
  dispatch(event: Event, args?: readonly unknown[]): void {
    if (this.deferToCommit(event, args, false)) return;
    void this.runListeners(event, args);
  }

  /**
   * Fires the event and resolves once every **sync** listener has settled.
   *
   * On an `afterCommit` event inside an open transaction it resolves
   * **immediately, having run nothing** — there is no listener to wait for yet,
   * and the transaction it would be waiting on is the caller's own. That is the
   * sharp edge `Event.afterCommit` documents and the reason the flag ships
   * opt-in; it warns once per event name in development, because nothing else
   * about the call site can show it.
   */
  async dispatchAndWait(
    event: Event,
    args?: readonly unknown[],
  ): Promise<void> {
    if (this.deferToCommit(event, args, true)) return;
    return this.runListeners(event, args);
  }

  /**
   * Queues the fan-out on the open transaction when the event asked for that,
   * and reports whether it did — `false` means the caller runs it now.
   *
   * Three cases, and only the third defers: an event without
   * `static afterCommit` behaves exactly as it did before this existed; one
   * with it, dispatched outside a transaction, has nothing to wait for; one
   * with it, inside a transaction, runs when that transaction commits and not
   * at all if it rolls back.
   *
   * `currentTransaction()` is not consulted directly, and the difference
   * matters: `deferUntilCommit` also answers `false` for a scope carrying a
   * handle that `withTransaction` did not open, which has no commit hook and
   * therefore no list that will ever be drained. Reading the handle alone would
   * queue the dispatch onto nothing and lose it silently.
   *
   * The whole fan-out is deferred, sync listeners and queued ones alike. A
   * queued listener is *pushed* at commit rather than at dispatch, which is the
   * only correct reading of `afterCommit`: the queue drains in-process and
   * often synchronously from `push`, so pushing early is running early.
   */
  private deferToCommit(
    event: Event,
    args: readonly unknown[] | undefined,
    awaited: boolean,
  ): boolean {
    // Read off the constructor, the same way the registry key is, and typed
    // structurally for the same reason: `Event` arrives here as a type-only
    // import, and the class object an application dispatches may have come from
    // a different module graph than the one this file was compiled against.
    const { name, afterCommit } = event.constructor as {
      name: string;
      afterCommit?: boolean;
    };
    if (!afterCommit) return false;

    const deferred = deferUntilCommit(() => this.runListeners(event, args));
    if (deferred && awaited) this.warnNothingIsWaitedFor(name);
    return deferred;
  }

  /**
   * Runs every **sync** listener bound to this event, in registration order,
   * and resolves when the last of them has settled. Every queued one is handed
   * to the `QueueManager` on the way past and is not waited for.
   *
   * The dispatch itself is `dispatch` and `dispatchAndWait` above; this is what
   * they run, and what an `afterCommit` event's transaction runs later. Split
   * out so that "when does the fan-out happen" is decided in exactly one place
   * rather than in each entry point.
   *
   * ### Sync and queued in one pass
   *
   * A queued listener is pushed at the point in the order it occupies, so its
   * *dispatch* is ordered with the rest and its *execution* is not: the queue
   * decides when. What that costs is worth knowing — `dispatchAndWait`
   * resolving says every sync listener has finished and says nothing at all
   * about a queued one, which may not have started or may already have failed
   * twice. Whether a listener is queued is therefore a decision about what the
   * caller can rely on having happened, not only about latency.
   *
   * @param args the arguments the event's constructor was called with, which
   * `Event.dispatch` forwards. Only a queued listener needs them: the event
   * instance itself never crosses the queue, and what is rebuilt on the other
   * side is `new EventClass(...args)`. Dispatching a hand-built instance
   * straight at the manager therefore cannot queue, and says so on stderr
   * rather than pushing a payload that would rehydrate into an event with
   * `undefined` fields.
   *
   * ### One at a time, deliberately
   *
   * Each listener is awaited before the next one starts, rather than started
   * together under a `Promise.allSettled`. Concurrency would make "registration
   * order" a claim about start order only, and the order it is a claim about is
   * the one `registeredListeners` reports and the discovery tests assert on.
   *
   * What it costs is worth knowing, because it is the one way listener
   * independence is not total: a listener that *hangs* — an un-timed-out
   * `fetch` to a host that never answers — delays every listener after it for
   * as long as it hangs, and under `dispatch` the caller has already moved on,
   * so an audit row a later listener writes simply is not there yet. A throw is
   * not this: that is caught below and the next listener runs immediately. A
   * listener that can block indefinitely is a listener that wants its own
   * timeout, or a `Job`.
   *
   * ### Errors
   *
   * Each listener runs inside its own `try`. A throw is logged with the event
   * name, the listener name, and the error, and the loop continues — listeners
   * are independent side effects, and letting listener 2 cancel 3 through 5
   * would make a filesystem walk's order load-bearing. Neither this nor
   * `dispatch` ever rejects, for the same reason from the caller's side: a
   * rejection would make listener 1's failure the dispatcher's problem while
   * listener 5's silently is not.
   *
   * ### Why zero listeners is worth a line on stderr
   *
   * A registry keyed by the wrong string, a `static name` that does not survive
   * a production build, a typo, and a listener directory that was never walked
   * all produce the same single symptom: nobody handled it. Zero listeners is
   * also a perfectly legal steady state, so the warning is development-only and
   * fires once per event name — a dispatch in a loop would otherwise bury the
   * terminal.
   */
  protected async runListeners(
    event: Event,
    args?: readonly unknown[],
  ): Promise<void> {
    const name = (event.constructor as { name: string }).name;
    const handlers = this.listeners[name];

    if (!handlers?.length) {
      this.warnNothingIsListening(name);
      return;
    }

    for (const { listener: Listener, job } of handlers) {
      if (job) {
        this.enqueue(job, Listener, name, args);
        continue;
      }

      try {
        await new Listener().handle(event);
      } catch (error) {
        console.error(
          `The listener ${Listener.name} threw while handling ${name}. The ` +
            `listeners after it still ran — a listener's failure is its own.`,
          error,
        );
      }
    }
  }

  /**
   * Rebuilds an event from what crossed the queue.
   *
   * The queue carries a name and an argument array, because that is all JSON
   * can carry: **the constructor arguments are what is serialized, not the
   * instance** — the same bargain `Job.dispatch` makes. So an event whose
   * constructor does work beyond assigning fields does that work a second time
   * here, in the worker, with none of the dispatching request around it.
   *
   * A name that resolves to nothing throws, and is the one place in this file
   * that does. The payload is already off the queue by the time this runs and
   * the listener is one line away from being handed `undefined`, so the
   * alternative is a `handle` reading `event.email` off nothing, several frames
   * further on, with the name that would have explained it no longer in scope.
   * A throw here is caught by `QueueManager.run` and takes the queue's ordinary
   * retry-then-dead-letter path.
   */
  rehydrate(eventName: string, args: readonly unknown[] = []): Event {
    const EventClass = this.events[eventName];

    if (!EventClass) {
      throw new Error(
        `Cannot rebuild the event "${eventName}" that came off the queue: no ` +
          `registered listener binds to an event of that name, so there is no ` +
          `class to construct. A queued listener runs in an application that ` +
          `discovered its own listeners — check that this process sees the ` +
          `same app/listeners as the one that dispatched, and that the event ` +
          `declares \`static name = "${eventName}"\`.`,
      );
    }

    return new EventClass(...args);
  }

  /**
   * Hands one queued listener to the queue, as `[eventName, args]`.
   *
   * Nothing is awaited: `push` returns as soon as the entry is on the queue,
   * which is the whole of what `queued = true` buys. The event instance the
   * sync listeners share does not go with it — only the name and the arguments
   * do, so nothing that was resolved from the request's context can be smuggled
   * across into an application that does not have it.
   *
   * Failing to queue is caught for the same reason a listener's throw is: it is
   * one listener's problem, and the listeners after it in the walk did not do
   * anything to deserve it. Two things reach that catch — an argument JSON
   * cannot serialise, and an application with no queue bound — and both would
   * otherwise reject `dispatchAndWait`, which is documented never to.
   */
  private enqueue(
    job: new () => Job,
    listener: ListenerClass,
    eventName: string,
    args?: readonly unknown[],
  ) {
    if (args === undefined) {
      console.error(
        `The listener ${listener.name} is queued, but ${eventName} reached ` +
          `the dispatcher without its constructor arguments, so there is ` +
          `nothing for the queue to rebuild it from and the listener was ` +
          `skipped. Dispatch through ${eventName}.dispatch(...) or ` +
          `${eventName}.dispatchAndWait(...), which carry them.`,
      );
      return;
    }

    try {
      app(QueueManager).push(job, JSON.stringify([eventName, args]));
    } catch (error) {
      console.error(
        `The listener ${listener.name} could not be queued for ${eventName}, ` +
          `so it did not run and will not be retried. The listeners after it ` +
          `still ran.`,
        error,
      );
    }
  }

  /**
   * The one warning for the pairing that reads as doing something and does not.
   *
   * `await UserRegistered.dispatchAndWait(...)` inside a transaction, on an
   * event that defers to commit, resolves with nothing having run — the
   * listeners are queued on a transaction the caller has not finished. There is
   * no other symptom: the promise resolves, the listeners do run later, and the
   * only thing that is wrong is that the caller's `await` bought it nothing.
   * Code that reads what a listener wrote on the next line finds it missing,
   * and nothing connects the two.
   *
   * Development only and once per event name, on the same terms as the
   * zero-listener warning: both are legal steady states that are usually a
   * mistake, and a dispatch in a loop must not bury the terminal.
   */
  private warnNothingIsWaitedFor(name: string) {
    if (process.env.NODE_ENV === "production") return;
    if (this.warnedAboutWaiting.has(name)) return;
    this.warnedAboutWaiting.add(name);

    console.warn(
      `[gemi] ${name}.dispatchAndWait() was called inside a transaction and ` +
        `${name} declares \`static afterCommit = true\`, so it resolved ` +
        `immediately with no listener having run — they run when the ` +
        `transaction commits. Await the transaction instead, or drop ` +
        `afterCommit if the caller needs the side effects first. Development ` +
        `only.`,
    );
  }

  private warnNothingIsListening(name: string) {
    if (process.env.NODE_ENV === "production") return;
    if (this.warnedFor.has(name)) return;
    this.warnedFor.add(name);

    console.warn(
      `[gemi] ${name} was dispatched and nothing is listening for it. A ` +
        `listener registers under the name its event declares, so check that ` +
        `app/listeners holds a Listener with \`static event = ${name}\` and ` +
        `that ${name} declares \`static name = "${name}"\`. Development only.`,
    );
  }
}
