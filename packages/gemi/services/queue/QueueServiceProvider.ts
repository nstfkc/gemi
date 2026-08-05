import { ServiceProvider } from "../../support/ServiceProvider";
import { discoverJobs } from "../discovery";
import { withDefaults } from "../../support/withDefaults";
import { queueConfigDefaults, type QueueConfig } from "./config";
import { QueueManager } from "./QueueManager";

export class QueueServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      QueueManager,
      () => new QueueManager(this.app.config.get<QueueConfig>("queue", {})),
    );
  }

  /**
   * Fills in the job registry when the app did not declare one.
   *
   * ### Why the raw slice and not the manager's config
   *
   * The decision here is whether the app said anything, and by the time the
   * manager holds a config it can no longer tell: `withDefaults` treats an
   * absent key and an `undefined` one alike and substitutes the default `[]`,
   * which is the same value an app writes when it means "no jobs, and I mean
   * it". Reading the slice before defaults are applied is the only place the
   * difference still exists.
   *
   * So: `jobs` present, including `jobs: []`, is used verbatim and no directory
   * is read. Absent or `undefined`, the classes under `jobsDir` are.
   *
   * ### Why phase two
   *
   * Discovery imports every file it walks, which is asynchronous, and
   * `register()` is not. It also has to happen before the first dispatch rather
   * than before the first tick — there is no equivalent of the scheduler's
   * `start()` to hang it off, so the registry has to be complete by the end of
   * boot.
   */
  async boot() {
    const slice = this.app.config.get<QueueConfig>("queue", {});
    if (slice.jobs !== undefined) return;

    const { jobsDir } = withDefaults(queueConfigDefaults(), slice);
    this.app.make(QueueManager).useJobs(await discoverJobs(jobsDir));
  }
}
