import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import {
  discoverClasses,
  DiscoveryError,
  projectRoot,
} from "../support/discover";
import { Command, type CommandClass } from "../console/Command";
import { commandConfigDefaults } from "../console/config";
import { isUnfinishedBuilder } from "../console/builder";
import { CronJob } from "./cron/CronJob";
import { scheduleConfigDefaults } from "./cron/config";
import { eventConfigDefaults } from "./events/config";
import type { EventClass } from "./events/Event";
import { Listener, type ListenerClass } from "./events/Listener";
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

/**
 * The `Command` subclasses under `dir`, defaulting to the config slice's
 * `app/commands`.
 *
 * This is what a `commands`-less `command` slice resolves to, and what
 * `gemi run` lists. Unlike the two above it is not called during boot — a
 * command registry has one consumer, and importing every file under
 * `app/commands` into every server process would be a cost paid on every start
 * for code no request reaches.
 *
 * Every file underneath is imported, so calling this runs the app's command
 * modules — the cost `discoverClasses` documents at length, paid once per call.
 */
export async function discoverCommands(
  dir: string = commandConfigDefaults().commandsDir,
): Promise<CommandClass[]> {
  const resolved = resolveDir(dir);
  warnIfSourceIsMissing(resolved, "commands", "command");

  const unfinished: string[] = [];

  const commands = await discoverClasses(
    resolved,
    Command,
    [],
    (value, file) => {
      if (isUnfinishedBuilder(value)) unfinished.push(file);
    },
  );

  refuseUnfinishedBuilders(unfinished);

  return commands as CommandClass[];
}

/**
 * Stops the walk for a builder chain that was never finished.
 *
 * This is the one silence the builder introduces, and it is the exact shape
 * #322 and #323 exist to remove. `defineCommand(...).arg(...)` without a
 * trailing `.handle(...)` is a plain object rather than a class, so
 * `discoverClasses` discards it along with every constant and helper a command
 * file happens to export — and the command disappears from `gemi run` with
 * nothing raised. The author sees a listing containing every command except the
 * one they just wrote.
 *
 * A throw rather than a warning, because there is no reading of an unfinished
 * builder under which the author meant it: the chain builds a description of a
 * command and then discards it.
 *
 * "Unfinished" is decided by `.handle()` clearing the brand, not by the export
 * still being a builder object. Those differ for the natural way to share
 * declarations —
 *
 *     export const base = defineCommand("reindex").option("verbose", …);
 *     export default base.handle(async () => {});
 *
 * — where `base` is a builder that *did* produce a command. Keying off the shape
 * alone made that file abort the whole of `gemi run`, taking every other command
 * in the project down with it, under a message that was untrue for it.
 */
function refuseUnfinishedBuilders(files: string[]): void {
  if (files.length === 0) return;

  const subject =
    files.length === 1
      ? `${files[0]} exports a command builder that never called \`.handle()\``
      : `${files.length} files export a command builder that never called ` +
        `\`.handle()\`:\n    ${files.join("\n    ")}`;

  throw new DiscoveryError(
    `${subject}, so there is no command to run. \`.handle()\` is what turns ` +
      `the chain into a command — finish it:\n\n` +
      `    export default defineCommand("my-command")\n` +
      `      .handle(async ({ line }) => { line("hello") })`,
  );
}

/**
 * The `Listener` subclasses under `dir`, defaulting to the config slice's
 * `app/listeners`.
 *
 * This is what an `events` config slice with no `listeners` key resolves to.
 * Call it directly to ask what an application would register: every listener,
 * in the order it would register them.
 *
 * Only listeners are walked. Event classes are never discovered — each is
 * imported by the listener that binds to it and by the code that dispatches it,
 * so there is nothing a walk over them would find that is not already in the
 * module graph.
 *
 * **Known residual, matching jobs and cron.** `discoverClasses` excludes the
 * `base` it is handed and not intermediates, so an abstract listener base
 * written in `listenersDir` and extended by its siblings is discovered and
 * registered alongside them — constructed, with its `handle` called, on every
 * dispatch of whatever event it declares. Keep shared bases outside the
 * directory.
 *
 * Every file underneath is imported, so calling this runs the app's listener
 * modules — the cost `discoverClasses` documents at length, paid once per call.
 *
 * @throws DiscoveryError if a discovered listener declares no `static event`.
 */
export async function discoverListeners(
  dir: string = eventConfigDefaults().listenersDir,
): Promise<ListenerClass[]> {
  const resolved = resolveDir(dir);
  warnIfSourceIsMissing(resolved, "event listeners", "events");

  const listeners = (await discoverClasses(
    resolved,
    Listener,
  )) as ListenerClass[];

  refuseListenersWithNoEvent(listeners);
  warnIfListenerNameWillNotSurviveTheBuild(listeners);
  warnIfEventNameWillNotSurviveTheBuild(listeners);

  return listeners;
}

/**
 * Stops the walk for a listener that binds to nothing.
 *
 * `static event` is declared as required on the base and the compiler still
 * cannot see it missing: every subclass inherits the declaration whether or not
 * it assigns to one, so `typeof SomeListener` type-checks either way. What the
 * author gets instead is a file that is imported, registered under no name, and
 * never called — the silence this whole module is arranged against.
 *
 * A throw rather than a warning, because there is no reading of a listener with
 * no event under which the author meant it. The usual cause is the residual
 * above: an abstract base sharing a gate between two listeners, sitting in
 * `listenersDir` where the walk finds it. Moving it out is the fix, and the
 * message says so — the alternative, excluding it by some guess about
 * abstractness, is how a discovery pass ends up quietly covering less than the
 * directory holds.
 */
function refuseListenersWithNoEvent(listeners: ListenerClass[]): void {
  const orphans = listeners.filter((listener) => !listener.event);
  if (orphans.length === 0) return;

  throw new DiscoveryError(
    `${orphans
      .map((listener) => listener.name)
      .join(", ")} declare no \`static event\`, so there is no event name to ` +
      `register them under and their \`handle\` would never run. Every ` +
      `listener binds to exactly one event:\n\n` +
      `    static event = UserRegistered;\n\n` +
      `If this is an abstract base its subclasses extend, move it out of the ` +
      `listeners directory — the walk excludes gemi's \`Listener\` and ` +
      `nothing else, so a base sitting beside its subclasses is registered ` +
      `and run like one of them.`,
  );
}

/**
 * Says something about a discovered listener that never declared `static name`.
 *
 * The hazard is `warnIfNameWillNotSurviveTheBuild`'s, one subsystem over: a
 * `static name = "..."` class field defines a *writable* own property while the
 * implicit class binding does not, and a minifier renames the binding while
 * leaving the string literal alone. The two spellings are indistinguishable by
 * value — both read `"SendWelcomeEmail"` in development — so the descriptor is
 * the only thing that tells them apart, and the difference only becomes visible
 * in a production build.
 *
 * Unlike a job's, a listener's own name has no second half to disagree with
 * *yet*: every reader of it today comes from this same source-side walk, so a
 * minified build and this walk cannot currently produce two different strings
 * for it. It is asked for from the start anyway, because the moment a listener
 * name is carried anywhere the server bundle can also produce — a queue
 * payload, a stored retry — the disagreement is silent and the fix would be a
 * rule changing under applications that had already shipped.
 */
function warnIfListenerNameWillNotSurviveTheBuild(listeners: ListenerClass[]) {
  for (const listener of listeners) {
    if (Object.getOwnPropertyDescriptor(listener, "name")?.writable) continue;

    console.warn(
      `Event listener ${listener.name} does not declare \`static name\`, so ` +
        `it is registered under its class name, which a production build ` +
        `renames. Add: static name = "${listener.name}";`,
    );
  }
}

/**
 * Says something about the *event* a discovered listener binds to, when that
 * event's name is the implicit class binding.
 *
 * This is the check that matters from the first dispatch, and it is the reason
 * `discoverListeners` reads `static event` at all. The registry is keyed by the
 * event's name; the dispatcher supplies that name from the class it constructs.
 * A production build minifies the server entry and the app code reachable from
 * it — the controller, and the event class it imports in order to dispatch —
 * while discovery imports `app/listeners/*.ts` from source, and those files
 * import `app/events/*.ts` from source too. Two module graphs, two class
 * objects, and an implicit `.name` that reads `"UserRegistered"` on one side
 * and `"D"` on the other. The dispatch then finds no listeners, which is legal,
 * normal, and completely silent.
 *
 * A declared `static name` is a string literal, which survives minification
 * intact, and the two halves agree again.
 *
 * Checked through the descriptor rather than the string, and not by comparing
 * `event.name` to anything: in development the two spellings produce the same
 * value, so a check on the string would be a tautology that passes forever.
 */
function warnIfEventNameWillNotSurviveTheBuild(listeners: ListenerClass[]) {
  const warned = new Set<EventClass>();

  for (const { event } of listeners) {
    if (warned.has(event)) continue;
    if (Object.getOwnPropertyDescriptor(event, "name")?.writable) continue;
    warned.add(event);

    console.warn(
      `Event ${event.name} does not declare \`static name\`, so it is ` +
        `dispatched under its class name. A production build minifies the ` +
        `code that dispatches it and renames the class, while discovery reads ` +
        `the listener's copy from source and does not — so the dispatch would ` +
        `reach no listener in production and nowhere else. Add: ` +
        `static name = "${event.name}";`,
    );
  }
}
