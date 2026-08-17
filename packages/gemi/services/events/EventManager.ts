import { withDefaults } from "../../support/withDefaults";
import { eventConfigDefaults, type EventConfig } from "./config";
import type { Event } from "./Event";
import type { ListenerClass } from "./Listener";

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
 */
export class EventManager {
  static token = "events";

  /** Event name -> every listener bound to it, in registration order. */
  private listeners: Record<string, ListenerClass[]> = {};

  /**
   * Event names already warned about. Per-manager, and the manager is per
   * application, so a test that builds a fresh kernel gets a fresh set.
   */
  private warnedFor = new Set<string>();

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
   */
  useListeners(listeners: ListenerClass[]) {
    this.config.listeners = listeners;

    this.listeners = {};
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

      // Two classes with one name. It only reaches the wire once a listener can
      // be queued, but it is refused from the start so the rule does not appear
      // to change under applications later — and a directory walk is what makes
      // the clash ordinary, since nothing forces the import alias a
      // hand-written list would have demanded.
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
      // dispatcher both agree on. Nothing downstream keeps the class object.
      const name = listener.event.name;
      (this.listeners[name] ??= []).push(listener);
    }
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
   * Nothing is awaited and nothing can reject: `dispatchAndWait` catches every
   * listener's failure itself, so the floating promise here has no rejection to
   * float.
   */
  dispatch(event: Event): void {
    void this.dispatchAndWait(event);
  }

  /**
   * Runs every listener bound to this event, in registration order, and
   * resolves when the last of them has settled.
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
  async dispatchAndWait(event: Event): Promise<void> {
    const name = (event.constructor as { name: string }).name;
    const handlers = this.listeners[name];

    if (!handlers?.length) {
      this.warnNothingIsListening(name);
      return;
    }

    for (const Listener of handlers) {
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
