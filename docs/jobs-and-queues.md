# Jobs & Queues

Jobs move slow or non-essential work off the request path. Instead of making a user wait while you call an external API, generate an image, or send a batch of emails, you dispatch a **Job** — it runs in the background through gemi's in-process queue, and the request returns immediately.

You define jobs as classes extending `Job` (from `gemi/services`) in files under `app/jobs/`, and fire them with `Job.dispatch(...)`. The directory is read at boot, so there is no list to keep alongside it.

## Defining a job

A job is a class extending `Job` with a **static `name`** and a `run` method that does the work. The parameters of `run` are your job's payload.

```typescript
// app/jobs/ProcessVideoJob.ts
import { Job } from "gemi/services";

type Params = {
  videoId: string;
};

export class ProcessVideoJob extends Job {
  static name = "ProcessVideoJob";

  async run(params: Params) {
    // Slow, non-blocking work the user shouldn't wait on: transcode the
    // uploaded video, generate thumbnails, store the results, etc.
    await transcodeVideo(params.videoId);
  }
}
```

> **Note:** The static `name` is **required** — jobs are enqueued and dispatched to workers by this name, and dispatching a job whose `name` is still the default (`"unset"`) throws. Give every job a unique static `name`.
>
> Omitting it does not fall back harmlessly to the class name, and under discovery it fails in production only. `gemi build` minifies the server entry, and the app code reachable from it — a controller, and every job class it imports to dispatch — is bundled and minified with it. That renames the class binding, and a class's implicit `.name` *is* that binding, so `TestJob` becomes something like `D` in the bundle. Discovery reads `app/jobs/TestJob.ts` from source at runtime, where it is still `TestJob`, and the two halves stop agreeing. A declared `static name` is a string literal, which survives minification intact. Discovery warns at boot about any job that leaves it out.

### Lifecycle hooks

`Job` exposes hooks that run around `run`, each receiving the result/error plus the original `run` arguments:

```typescript
export class ProcessVideoJob extends Job {
  static name = "ProcessVideoJob";
  maxAttempts = 3; // retries before dead-lettering (default 3)

  async run(params: Params) { /* ... */ }

  onSuccess(result: any, params: Params) { /* ran after run resolves */ }
  onFail(error: Error, params: Params) { /* ran on each failed attempt */ }
  onDeadletter(error: Error, params: Params) { /* ran after the last attempt fails */ }
}
```

Retry behavior: when `run` throws, `onFail` fires and the job is re-queued until it has been attempted `maxAttempts` times; once the final attempt fails, `onDeadletter` fires and the job is dropped.

### Configurable fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `static name` | `string` | `"unset"` | Unique job identifier. Required. |
| `maxAttempts` | `number` | `3` | Total attempts before dead-lettering. |
| `worker` | `boolean` | `false` | When `true`, `run` executes in a separate Worker thread (a fresh cloned app instance) instead of the main event loop — use for CPU-bound work you want off the main thread. |

## Dispatching

Call the static `dispatch` method with exactly the arguments your `run` method takes — the call is fully typed against `run`'s signature.

```typescript
import { ProcessVideoJob } from "@/app/jobs/ProcessVideoJob";

// Inside a controller — returns immediately; the job runs in the background.
ProcessVideoJob.dispatch({ videoId: video.id });
```

`dispatch` enqueues the job and returns `void` (fire-and-forget) — it does not wait for the job to finish, and the payload is serialized as JSON, so pass plain, serializable data (not class instances or functions). See [Controllers](./controllers.md) for dispatching from request handlers.

## Registering jobs — `app/jobs/`

Jobs are discovered. Every class under `app/jobs` that extends `Job` is registered when the kernel boots, so writing the file is all it takes — there is no list to keep in step with it.

That is deliberate, and it is about the failure that happens when the two disagree. The queue looks a dispatched job up by name; a name it has never heard of is dropped with a line on stderr and nothing else. `Job.dispatch` has already returned by then — it returns as soon as the job is queued, not when it runs — so the dispatch simply does not happen, whatever was supposed to follow it does not either, and the only trace is in the server log.

### Two jobs, one class name

The queue's key is the **class name**, and that is also what a dispatch carries — so two `Job` subclasses called `SendEmail` cannot both be registered. The first is, the second is refused with a line on stderr, and `Job.dispatch` on either resolves to the first.

Worth spelling out because the failure it replaces was the worst one in this subsystem: the registry used to keep whichever came last, silently, so `SendEmail.dispatch(...)` written against `app/jobs/auth/SendEmail.ts` would run the body of `app/jobs/billing/SendEmail.ts`. Nothing was dropped and nothing errored — the wrong work happened and reported success. A hand-written list forced an import alias the moment two names clashed; a directory walk does not, so `auth/SendEmail.ts` beside `billing/SendEmail.ts` is an entirely ordinary thing to write. Rename one.

Both still appear in `registeredJobs`, which reports what the manager was handed rather than what the registry accepted, so a test walking it sees the clash.

### What the walk costs

A class does not exist until its module has run, so there is no way to read a directory of classes without importing it. **Every `.ts`/`.tsx` file under `app/jobs` is imported at boot** — in development and in production, on every start — and a file that *does something* when it is imported does that thing at boot. A module that opens a connection, seeds a cache, or registers a listener at the top level is doing it before the first request, from a directory nobody thought of as an entry point.

So `app/jobs` wants to hold job declarations rather than merely contain some. Keep a helper that runs work on import somewhere else, or list the jobs explicitly (below) and skip the walk entirely. A file that cannot be imported at all — one reaching a `?raw` or `.css` specifier through its imports, say — fails the boot naming itself, rather than being quietly left out of the registry.

The walk skips what certainly is not a declaration: `.d.ts` files, tests, type tests and benchmarks by their filename suffix, dot-directories, `node_modules`, and anything under a directory carrying its own `package.json`. Nothing else is guessed at.

A new file is picked up on the next server reload — under `gemi dev`, creating a file does not by itself trigger one, so save any other file (or restart) if a job you just wrote has not appeared.

### Configuring the queue — `app/config/queue.ts`

The `queue` slice is where `concurrency` lives, and where you can take over registration yourself. Declaring `jobs` turns discovery off and uses your list verbatim — reach for it when the jobs live somewhere the walk cannot reach, when you want a deliberate subset, or when the deploy ships only the build output and there is no `app/jobs` on disk to read.

```typescript
// app/config/queue.ts
import { defineQueueConfig } from "gemi/services";
import { ProcessVideoJob } from "@/app/jobs/ProcessVideoJob";

export default defineQueueConfig({
  concurrency: 20, // max jobs running at once (default 1)
  jobs: [ProcessVideoJob], // omit to discover them from app/jobs
});
```

`defineQueueConfig` is an identity helper — it exists only to type the object.

**A present `jobs` wins, and `jobs: []` is present.** An empty array means an application with no jobs and is honoured as such; it does not mean "go and find some". Leaving the key out — or leaving the slice out entirely — is what asks for discovery.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `jobs` | `(new () => Job)[]` | *discovered* | All dispatchable job classes. Omit to discover them from `jobsDir`. A job that reaches neither is dispatched into nothing. |
| `jobsDir` | `string` | `"app/jobs"` | Where to discover them. Relative to the project root, or absolute. |
| `concurrency` | `number` | `1` | Maximum number of jobs processed simultaneously. |

The slice is wired into the kernel by name:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import queue from "../config/queue";

export default class extends Kernel {
  config = { queue /* , ...other slices */ };
}
```

Behind the scenes the framework's `QueueServiceProvider` reads that slice in its `register()` and binds a `QueueManager` singleton into the container under the token `"queue"`, then fills in the discovered jobs in its `boot()`. You never construct or reference the provider yourself — providers register bindings, config configures them.

### Resolving the queue

`QueueManager` is a normal container binding, so you can resolve it directly when you need the manager rather than a job:

```typescript
import { app } from "gemi/foundation";
import { QueueManager } from "gemi/services";

app(QueueManager); // typed QueueManager, no cast
```

`registeredJobs` is the set it ended up with, discovered or declared. That is what a test asserts against now — an app that used to import the `jobs` array from its config module to check something about every job it dispatches asks the manager instead:

```typescript
import { app } from "gemi/foundation";
import { QueueManager } from "gemi/services";

for (const Registered of app(QueueManager).registeredJobs) {
  expect(new Registered().maxAttempts).toBeGreaterThan(0);
}
```

`discoverJobs()` answers the same question without an application around it — it walks `app/jobs` (or a directory you name) and returns the classes it finds. Every file it walks is imported, as above:

```typescript
import { discoverJobs } from "gemi/services";

const jobs = await discoverJobs(); // every Job subclass under app/jobs
```

See [Project Structure](./project-structure.md) for the full kernel layout.

> **Coming from Laravel:** the vocabulary is the same — a `ServiceProvider` registers bindings into the `Container`, config lives in `app/config`, and facades are static proxies to container-resolved services. Two things are deliberately different: job retry/failure behavior lives on the job class (`maxAttempts`, `onFail`, `onDeadletter`) rather than in a queue driver's config, and per-subsystem hooks across the framework (`filterRecipients`, `onLogCreated`, `detectLocale`, ...) are **config callbacks** in `app/config/*.ts` rather than macros you register from a provider's `boot()`. Use `boot()` only for wiring you cannot express as data — see `app/providers/AppServiceProvider.ts`.

> **Note:** The queue is **in-process and in-memory** — jobs live in the running server's memory and are processed by that same process (or, for `worker` jobs, a Worker thread it spawns). Enqueued jobs do not survive a restart, and there is no cross-machine/distributed queue. Use jobs for best-effort background work (translations, image processing, notifications), not for work that must be durably guaranteed across restarts.

## When to use a job

Reach for a job when work is:

- **Slow** — external API calls, AI generation, image/video processing.
- **Non-blocking** — the user doesn't need the result in the HTTP response.
- **Batchable or retryable** — sending many emails, syncing records, where automatic retries help.

For work that must happen on a **schedule** (nightly reports, hourly cleanups) rather than in response to a request, use a cron job instead — see [Cron](./cron.md).

## Related

- [Commands](./commands.md) — one-off work a person starts by hand, which often dispatches jobs.
- [Cron](./cron.md) — scheduled, recurring background work.
- [Controllers](./controllers.md) — dispatching jobs from request handlers.
- [Project Structure](./project-structure.md) — the kernel, `app/config/*.ts`, and service providers.
- [Configuration](./configuration.md) — environment setup.
