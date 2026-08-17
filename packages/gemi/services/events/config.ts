import type { ListenerClass } from "./Listener";

// Config key: `events`. Derived from `EventServiceProvider`.
export interface EventConfig {
  /**
   * The `Listener` subclasses this application registers, or nothing.
   *
   * ### Why "or nothing" is the point
   *
   * A dispatch fans out to whatever the `EventManager` holds for the event's
   * name, and an event nothing is registered for is not an error — it is the
   * ordinary state of an application that has not written that listener yet.
   * So this list is a second spelling of `app/listeners`, kept in step by hand,
   * and what the two disagreeing costs is a side effect that stops happening,
   * with a development-only warning as the only trace. Nothing fails, nothing
   * is dropped from a log: the welcome email simply is not sent.
   *
   * Leaving this out spells it once: the listeners are the classes under
   * `listenersDir`.
   *
   * ### The rule, exactly
   *
   * **Declared wins, and `[]` is declared.** A `listeners` that is present is
   * used verbatim and no directory is read — that is the escape hatch for an
   * app whose listeners live somewhere this cannot walk, for one that
   * deliberately registers a subset, and for a deploy that ships no source. An
   * empty array means an app with no listeners and says so; it does not mean
   * "find some".
   *
   * **Absent or `undefined` discovers.** `undefined` counts as absent for the
   * same reason `withDefaults` treats it that way everywhere else: a key spread
   * in from an optional value is an omission, not an instruction.
   */
  listeners?: ListenerClass[];

  /**
   * Where to look when `listeners` was not declared. Relative to the project
   * root, or absolute.
   *
   * Every `.ts`/`.tsx` file underneath it is imported at boot and every
   * exported class extending `Listener` is registered, so this wants to be a
   * directory of listener declarations rather than a directory that merely
   * contains some. That includes an abstract base a few listeners share: the
   * walk excludes the framework's `Listener` and nothing else, so a base
   * sitting here is registered alongside its subclasses and its `handle` runs
   * on every dispatch of whatever event it declares. Keep shared bases outside
   * this directory.
   *
   * There is no `eventsDir` to go with it. Event classes are never discovered
   * — each is imported by the listener that binds to it and by the code that
   * dispatches it, so nothing needs to walk them and a walk that imported them
   * anyway would only be a boot cost.
   */
  listenersDir?: string;
}

export function defineEventConfig(config: EventConfig): EventConfig {
  return config;
}

export function eventConfigDefaults(): Required<EventConfig> {
  return {
    listeners: [],
    listenersDir: "app/listeners",
  };
}
