# Jobs & Queues

Jobs move slow or non-essential work off the request path. Instead of making a user wait while you call an external API, generate an image, or send a batch of emails, you dispatch a **Job** — it runs in the background through gemi's in-process queue, and the request returns immediately.

You define jobs as classes extending `Job` (from `gemi/services`), register them on your `QueueServiceProvider`, and fire them with `Job.dispatch(...)`.

## Defining a job

A job is a class extending `Job` with a **static `name`** and a `run` method that does the work. The parameters of `run` are your job's payload.

```typescript
// app/kernel/providers/jobs/ProcessVideoJob.ts
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
import { ProcessVideoJob } from "@/app/kernel/providers/jobs/ProcessVideoJob";

// Inside a controller — returns immediately; the job runs in the background.
ProcessVideoJob.dispatch({ videoId: video.id });
```

`dispatch` enqueues the job and returns `void` (fire-and-forget) — it does not wait for the job to finish, and the payload is serialized as JSON, so pass plain, serializable data (not class instances or functions). See [Controllers](./controllers.md) for dispatching from request handlers.

## Registering jobs — `QueueServiceProvider`

Every job class must be listed on your app's `QueueServiceProvider` so the queue knows how to construct it by name. You also set the worker `concurrency` here.

```typescript
// app/kernel/providers/QueueServiceProvider.ts
import { QueueServiceProvider } from "gemi/services";
import { ProcessVideoJob } from "./jobs/ProcessVideoJob";

export default class extends QueueServiceProvider {
  concurrency = 20; // max jobs running at once (default 1)

  jobs = [ProcessVideoJob];
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `jobs` | `(new () => Job)[]` | `[]` | All dispatchable job classes. A job not listed here cannot be dispatched. |
| `concurrency` | `number` | `1` | Maximum number of jobs processed simultaneously. |

See [Kernel & Service Providers](./project-structure.md) for how providers are wired into the kernel.

> **Note:** The queue is **in-process and in-memory** — jobs live in the running server's memory and are processed by that same process (or, for `worker` jobs, a Worker thread it spawns). Enqueued jobs do not survive a restart, and there is no cross-machine/distributed queue. Use jobs for best-effort background work (translations, image processing, notifications), not for work that must be durably guaranteed across restarts.

## When to use a job

Reach for a job when work is:

- **Slow** — external API calls, AI generation, image/video processing.
- **Non-blocking** — the user doesn't need the result in the HTTP response.
- **Batchable or retryable** — sending many emails, syncing records, where automatic retries help.

For work that must happen on a **schedule** (nightly reports, hourly cleanups) rather than in response to a request, use a cron job instead — see [Cron](./cron.md).

## Related

- [Cron](./cron.md) — scheduled, recurring background work.
- [Controllers](./controllers.md) — dispatching jobs from request handlers.
- [Kernel & Service Providers](./project-structure.md) — registering `QueueServiceProvider`.
- [Configuration](./configuration.md) — environment setup.
