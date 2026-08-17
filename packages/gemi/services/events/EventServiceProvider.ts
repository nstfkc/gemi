import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { discoverListeners } from "../discovery";
import { QueueManager } from "../queue/QueueManager";
import { eventConfigDefaults, type EventConfig } from "./config";
import { EventManager } from "./EventManager";

export class EventServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      EventManager,
      () => new EventManager(this.app.config.get<EventConfig>("events", {})),
    );
  }

  /**
   * Fills in the listener registry when the app did not declare one.
   *
   * ### Why the raw slice and not the manager's config
   *
   * The decision here is whether the app said anything, and by the time the
   * manager holds a config it can no longer tell: `withDefaults` treats an
   * absent key and an `undefined` one alike and substitutes the default `[]`,
   * which is the same value an app writes when it means "no listeners, and I
   * mean it". Reading the slice before defaults are applied is the only place
   * the difference still exists.
   *
   * So: `listeners` present, including `listeners: []`, is used verbatim and no
   * directory is read. Absent or `undefined`, the classes under `listenersDir`
   * are.
   *
   * ### Why phase two
   *
   * Discovery imports every file it walks, which is asynchronous, and
   * `register()` is not. It also has to finish before the first dispatch rather
   * than before the first request — a dispatch against an empty registry is not
   * an error, it is a side effect that quietly does not happen — so the
   * registry has to be complete by the end of boot.
   *
   * ### Why the queue is handed the listener jobs from here
   *
   * A queued listener is registered with the `QueueManager` as a synthetic job,
   * and that registration cannot happen in `register()`: resolving another
   * service is the one thing a `register()` must not do, and the jobs are not
   * known until discovery has run anyway. It also cannot happen before
   * `QueueServiceProvider.boot()` fills the queue's registry, which is why this
   * provider sits after it in `frameworkProviders` — `useJobs` replaces that
   * registry wholesale, so the queue has to be finished with it before
   * `registerJob` starts adding to it.
   *
   * The declared-listeners path falls through to it rather than returning
   * early: an app that lists its listeners in `app/config/events.ts` still has
   * queued ones, and skipping the queue for them would make `queued = true` a
   * field that silently does nothing depending on how the app registers.
   */
  async boot() {
    const manager = this.app.make(EventManager);
    const slice = this.app.config.get<EventConfig>("events", {});

    if (slice.listeners === undefined) {
      const { listenersDir } = withDefaults(eventConfigDefaults(), slice);
      manager.useListeners(await discoverListeners(listenersDir));
    }

    // Nothing queued, nothing to resolve. An application assembled out of this
    // provider alone — a test, a script — has no `QueueManager` bound, and
    // asking for one it has no use for would turn that into a boot failure.
    const jobs = manager.queuedListenerJobs;
    if (jobs.length === 0) return;

    const queue = this.app.make(QueueManager);
    for (const job of jobs) {
      queue.registerJob(job);
    }
  }
}
