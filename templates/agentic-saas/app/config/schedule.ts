import { defineScheduleConfig } from "gemi/services";

/**
 * The schedule.
 *
 * `jobs` is left out on purpose, and leaving it out is what asks gemi to read
 * `app/cron`: every `CronJob` subclass under there is scheduled at boot, so a
 * job is registered by existing. `app/cron/TestCron.ts` is scheduled by this
 * file saying nothing about it.
 *
 * Declare `jobs` to take that over — a present `jobs` is used verbatim and no
 * directory is read, and `jobs: []` counts as present. Do not write `jobs: []`
 * meaning "none yet"; it means "nothing scheduled, and I mean it", and the
 * directory stops being read.
 *
 * Either way, what the scheduler ended up with is `app(Scheduler).jobs`.
 */
export default defineScheduleConfig({});
