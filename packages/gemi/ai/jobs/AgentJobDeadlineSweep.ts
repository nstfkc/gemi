import { CronJob } from "../../services/cron/CronJob";
import { AgentJobs } from "./AgentJob";

/**
 * Fails background jobs that ran past their deadline (#461), every minute.
 *
 * Schedule it by exporting it from a file under `app/cron`:
 *
 *     export { AgentJobDeadlineSweep } from "gemi/ai";
 *
 * Safe on every instance at once: each job is failed by compare-and-set. An
 * app without it still sees an overdue job fail, when the controller next
 * loads the job's thread.
 */
export class AgentJobDeadlineSweep extends CronJob {
  name = "AgentJobDeadlineSweep";
  cron = "* * * * *";

  async callback(): Promise<void> {
    // In rounds, so a backlog after an outage is cleared in one tick without
    // holding one huge result set.
    while ((await AgentJobs.sweep({ limit: 100 })) === 100) {
      // keep going
    }
  }
}
