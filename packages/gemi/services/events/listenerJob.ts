import { app } from "../../foundation/app";
import { Job } from "../queue/Job";
import { EventManager } from "./EventManager";
import type { Listener, ListenerClass } from "./Listener";

/**
 * The adapter that lets `queued = true` be one line: a `Job` subclass, built at
 * registration, that runs exactly one listener.
 *
 * Retries, `maxAttempts`, dead-lettering, `concurrency` and worker-thread
 * execution are four features the queue already has, already documents for
 * applications, and is already tested on. A second queue for listeners would be
 * four features that are almost the same as those, differing in ways nobody
 * decided. So a queued listener is not queued by anything written here — it is
 * a job, and everything after `push` is the queue's.
 */

/**
 * The name a listener's synthetic job is registered under.
 *
 * Prefixed, and visibly so. The synthetic jobs land in
 * `QueueManager.registeredJobs` alongside the app's own, because that getter is
 * documented as reporting what the manager was handed and a queued listener
 * genuinely is something the queue will run — hiding them would make a queue
 * introspection tool lie about what is about to execute. The prefix is what
 * keeps an author from reading `SendWelcomeEmail` there and looking for a job
 * file they never wrote.
 */
export function listenerJobName(listenerName: string): string {
  return `listener:${listenerName}`;
}

/**
 * Builds the `Job` subclass that runs one queued listener.
 *
 * `instance` is the listener the caller already constructed to read `queued`
 * off; the three fields that decide where the work runs are read from that one
 * instance rather than from a fresh one per attempt, so a listener's
 * constructor runs once at boot instead of once per retry.
 *
 * What crosses the queue is `[eventName, constructorArguments]` as JSON — a
 * name and the arguments, never the event instance and never the classes. That
 * is invariant 1 at its second boundary: the class objects on the pushing side
 * and the running side can come from two different module graphs (a minified
 * bundle and a source-side discovery walk), so a name declared as a string
 * literal is the only thing both ends agree on. `EventManager.rehydrate` turns
 * it back into an event.
 */
export function jobForListener(
  listener: ListenerClass,
  instance: Listener,
): new () => Job {
  refuseImplicitName(listener);

  const attempts = instance.maxAttempts;
  const inWorker = instance.worker;

  const job = class extends Job {
    maxAttempts = attempts;
    worker = inWorker;

    async run(...payload: unknown[]) {
      const [eventName, args] = readPayload(payload);
      const event = app(EventManager).rehydrate(eventName, args);
      await new listener().handle(event);
    }
  };

  // Not cosmetic, either half of it. The queue keys its registry off
  // `job.name`, so without this the entry would be named after whatever
  // binding this class expression picked up. And `writable: true` is what
  // `warnIfNameWillNotSurviveTheBuild` reads to decide a name was *declared*:
  // a synthetic class whose `name` was a non-writable own property would be
  // reported to the author at every boot as a job they never wrote, under a
  // fix they cannot apply.
  Object.defineProperty(job, "name", {
    value: listenerJobName(listener.name),
    writable: true,
  });

  return job;
}

/**
 * Refuses to queue a listener whose name is the implicit class binding.
 *
 * A sync listener's name is only ever read inside one module graph, so
 * discovery warns about this and moves on. A queued one puts the name on the
 * wire: the push side looks the job up by `listener:<name>` in its registry and
 * the running side looks it up in *its* registry, and those two can be
 * different builds of the same application — the main process discovering
 * `app/listeners` from source while a `worker = true` listener runs in a thread
 * that imported `dist/server/bootstrap.mjs`, where minification renamed the
 * class. The names then disagree, `dispatchJob` resolves nothing, the worker
 * reports success, and the side effect silently stops happening in production.
 *
 * A throw rather than a warning because the failure is invisible from every
 * side once it happens, and because the fix is one line the author can read in
 * the message.
 */
function refuseImplicitName(listener: ListenerClass): void {
  if (Object.getOwnPropertyDescriptor(listener, "name")?.writable) return;

  throw new Error(
    `The listener ${listener.name} sets \`queued = true\` but does not ` +
      `declare \`static name\`, so it would be registered with the queue ` +
      `under its class name — which a production build renames while the ` +
      `payload that names it does not. Add: static name = "${listener.name}";`,
  );
}

/**
 * The payload, whichever of the two shapes the queue handed it over in.
 *
 * The queue calls `run` two different ways and this is the only place that has
 * to know. In-process, `QueueManager.run` spreads the parsed arguments:
 * `run("UserRegistered", [7, "ada@example.com"])`. Through a worker thread the
 * far side is `QueueManager.dispatchJob`, which passes the parsed array whole:
 * `run(["UserRegistered", [7, "ada@example.com"]])`. Reading only the first
 * shape would make `worker = true` a listener that receives an event named
 * `undefined` — a throw out of `rehydrate`, in a worker thread, retried to
 * dead-letter.
 *
 * The two are told apart by what is in the first slot rather than by counting
 * arguments, because the payload's own first element is always the event name
 * and a name is always a string.
 */
function readPayload(payload: unknown[]): [string, unknown[]] {
  return (typeof payload[0] === "string" ? payload : payload[0]) as [
    string,
    unknown[],
  ];
}
