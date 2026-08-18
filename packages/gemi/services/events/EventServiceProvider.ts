import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { discoverListeners } from "../discovery";
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
   */
  async boot() {
    const slice = this.app.config.get<EventConfig>("events", {});
    if (slice.listeners !== undefined) return;

    const { listenersDir } = withDefaults(eventConfigDefaults(), slice);
    this.app
      .make(EventManager)
      .useListeners(await discoverListeners(listenersDir));
  }
}
