import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { discoverClasses, projectRoot } from "../support/discover";
import { CronJob } from "./cron/CronJob";
import { scheduleConfigDefaults } from "./cron/config";
import { Job } from "./queue/Job";
import { queueConfigDefaults } from "./queue/config";

/**
 * Reading an application's jobs off the filesystem, for the two subsystems that
 * were asking every app to write its job list twice.
 *
 * Both functions here are the same call to `discoverClasses` with a different
 * base class, which is deliberate: one walk, one set of skip rules, one answer
 * to "what does this app have". They are exported from `gemi/services` rather
 * than kept private to the providers because the list stopped being something
 * an app could import — a test that used to walk the exported `jobs` array
 * needs somewhere to ask the same question, and so does a script.
 *
 * What the providers add on top of these is the decision of *whether* to ask,
 * which is the config's to make and not this file's.
 */

/**
 * A directory the app named, resolved the way the app meant it.
 *
 * Relative paths hang off the project root rather than `process.cwd()` at the
 * moment of the call, because a config slice saying `app/jobs` means the app's
 * `app/jobs` and not whatever directory somebody happened to launch a script
 * from. Absolute paths are taken as given, which is what makes these callable
 * from a test that has no project around it.
 */
function resolveDir(dir: string): string {
  return isAbsolute(dir) ? dir : join(projectRoot(), dir);
}

/**
 * Says something when the directory is missing *and so is the tree it lives in*.
 *
 * A missing directory has two readings and they want opposite responses. An app
 * that has never written a cron job has no `app/cron`, and warning about that on
 * every boot for the rest of its life is noise — the answer "you have no cron
 * jobs" is correct and uninteresting. But a deploy that ships `dist/` and
 * `node_modules/` without the source has no `app/cron` *and no `app/`*, and
 * there discovery quietly returns nothing while the app very much does have
 * jobs: the exact silence #322 and #323 exist to remove, reintroduced one layer
 * down and in production only.
 *
 * The parent directory is what tells them apart. If neither the directory nor
 * the one above it is there, the tree this was pointed into is not there
 * either, and that is worth a sentence.
 */
function warnIfSourceIsMissing(
  resolved: string,
  subject: string,
  slice: string,
) {
  if (existsSync(resolved) || existsSync(dirname(resolved))) return;

  console.warn(
    `No ${subject} were discovered: neither ${resolved} nor the directory ` +
      `above it exists, so this process cannot see the application's source. ` +
      `If this is a deploy that ships only the build output, list the classes ` +
      `explicitly in app/config/${slice}.ts so they travel with it.`,
  );
}

/**
 * The `Job` subclasses under `dir`, defaulting to the config slice's `app/jobs`.
 *
 * This is what a `queue` config slice with no `jobs` key resolves to. Call it
 * directly to ask the question a test used to answer by importing the array:
 * every job this application would register, in the order it would register
 * them.
 *
 * Every file underneath is imported, so calling this runs the app's job modules
 * — the cost `discoverClasses` documents at length, paid once per call.
 */
export async function discoverJobs(
  dir: string = queueConfigDefaults().jobsDir,
): Promise<Array<new () => Job>> {
  const resolved = resolveDir(dir);
  warnIfSourceIsMissing(resolved, "queue jobs", "queue");
  const jobs = await discoverClasses(resolved, Job);
  warnIfNameWillNotSurviveTheBuild(jobs);
  return jobs;
}

/**
 * Says something about a discovered job that never declared `static name`.
 *
 * This is the one hazard discovery introduces rather than removes, and it is
 * production-only. `gemi build` minifies the server entry, and app code
 * reachable from it — a controller, and every job class that controller
 * imports to dispatch — is bundled and minified with it. Minification renames
 * the class binding, and a class's implicit `.name` is that binding: a
 * `TestJob` in the bundle reports `"D"`. Discovery, meanwhile, imports
 * `app/jobs/TestJob.ts` from source at runtime, where it is still `"TestJob"`.
 * The queue is keyed by that name, so the two halves stop agreeing and the
 * dispatch is dropped — in production, and only there.
 *
 * A declared `static name = "TestJob"` is a string literal, which survives
 * minification intact, and the two halves agree again. `docs/jobs-and-queues.md`
 * has always called it required; before discovery an app could get away without
 * it, because the explicit `jobs` array was bundled too and both sides were
 * wrong in the same way.
 *
 * The check is exact rather than a guess: a `static name = "..."` class field
 * defines a *writable* own property, while the implicit class name is
 * non-writable. Cron is unaffected — `CronJob.name` is an instance field
 * holding a string literal, not the class binding.
 */
function warnIfNameWillNotSurviveTheBuild(jobs: Array<new () => Job>) {
  for (const job of jobs) {
    if (Object.getOwnPropertyDescriptor(job, "name")?.writable) continue;

    console.warn(
      `Queued job ${job.name} does not declare \`static name\`, so it is ` +
        `registered under its class name. A production build minifies the ` +
        `class that dispatches it and renames it, while discovery reads this ` +
        `file from source and does not — so the dispatch would be dropped in ` +
        `production and nowhere else. Add: static name = "${job.name}";`,
    );
  }
}

/**
 * The `CronJob` subclasses under `dir`, defaulting to the config slice's
 * `app/cron`.
 *
 * This is what a `schedule` config slice with no `jobs` key resolves to. Call it
 * directly to ask the question a test used to answer by importing the array —
 * though after boot `app(Scheduler).jobs` is the better one, because it is what
 * the scheduler actually took rather than what this would find if asked again.
 *
 * Every file underneath is imported, so calling this runs the app's cron
 * modules — the cost `discoverClasses` documents at length, paid once per call.
 */
export async function discoverCronJobs(
  dir: string = scheduleConfigDefaults().jobsDir,
): Promise<Array<new () => CronJob>> {
  const resolved = resolveDir(dir);
  warnIfSourceIsMissing(resolved, "cron jobs", "schedule");
  return await discoverClasses(resolved, CronJob);
}
