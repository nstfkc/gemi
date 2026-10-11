import type { ChangeFeedResponse, StreamOptions } from "../services/change-feed/stream";
import {
  type CreateRunOptions,
  type RunHandle,
  RunManager,
  type WaitOptions,
} from "../services/runs/RunManager";
import type { RunError, RunFilter, RunProgress, RunRecord } from "../services/runs/RunStore";
import type { Duration } from "../services/queue/workflow/duration";
import { Facade } from "./Facade";

/**
 * Tracked background runs (#908): status, progress, deadline, and waiting
 * for the outcome over the change feed instead of polling.
 *
 * ```ts
 * // Where the work is asked for:
 * const run = await Runs.create({ kind: "page-build", subject: `site:${site.id}`, deadline: "10m" });
 * await PageBuildJob.dispatch({ runId: run.id });
 *
 * // In the job:
 * await Runs.execute(runId, async (run) => {
 *   await run.progress({ fraction: 0.5, message: "Writing copy" });
 *   return { pageId };
 * });
 *
 * // Wherever the outcome is needed:
 * const done = await Runs.wait(run.id, { timeout: "2m" });
 * ```
 */
export class Runs extends Facade {
  static getFacadeAccessor() {
    return RunManager;
  }

  /** Records a new run, `pending` unless `start: true`. */
  static create<R = unknown, P = unknown>(options: CreateRunOptions): Promise<RunRecord<R, P>> {
    return this.getFacadeRoot().create<R, P>(options);
  }

  /** The run, or `null`. */
  static get<R = unknown, P = unknown>(id: string): Promise<RunRecord<R, P> | null> {
    return this.getFacadeRoot().get<R, P>(id);
  }

  /** Runs matching `filter` (kind, subject, owner, statuses), newest first. */
  static list(filter?: RunFilter): Promise<RunRecord[]> {
    return this.getFacadeRoot().list(filter);
  }

  /** `pending` → `running`; `null` when it was not pending. */
  static start(id: string): Promise<RunRecord | null> {
    return this.getFacadeRoot().start(id);
  }

  /** Replaces the run's progress; `null` once it has ended. */
  static progress<P = unknown>(id: string, progress: RunProgress<P>): Promise<RunRecord | null> {
    return this.getFacadeRoot().progress(id, progress);
  }

  /** Ends the run as `completed`; `null` when it had ended already. */
  static complete(id: string, result?: unknown): Promise<RunRecord | null> {
    return this.getFacadeRoot().complete(id, result);
  }

  /** Ends the run as `failed`; `null` when it had ended already. */
  static fail(id: string, error: string | RunError | Error): Promise<RunRecord | null> {
    return this.getFacadeRoot().fail(id, error);
  }

  /** Ends the run as `cancelled`; `null` when it had ended already. */
  static cancel(id: string, reason?: string): Promise<RunRecord | null> {
    return this.getFacadeRoot().cancel(id, reason);
  }

  /** Runs `fn` as the run's work, and settles the run from its outcome. */
  static execute<R, P = unknown>(
    id: string,
    fn: (run: RunHandle<P>) => Promise<R> | R,
  ): Promise<RunRecord<R, P>> {
    return this.getFacadeRoot().execute<R, P>(id, fn);
  }

  /** Resolves once the run has ended, or `timeout` passed. */
  static wait<R = unknown, P = unknown>(
    id: string,
    options?: WaitOptions,
  ): Promise<RunRecord<R, P>> {
    return this.getFacadeRoot().wait<R, P>(id, options);
  }

  /** The run now, then each newer version until it ends. */
  static subscribe<R = unknown, P = unknown>(
    id: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<RunRecord<R, P>, void, undefined> {
    return this.getFacadeRoot().subscribe<R, P>(id, options);
  }

  /** An SSE response following the run, for a route that authorised the read. */
  static stream(
    request: { rawRequest: Request } | Request,
    id: string,
    options?: StreamOptions,
  ): ChangeFeedResponse<RunRecord> {
    return this.getFacadeRoot().stream(request, id, options);
  }

  /** A cursor at the run's channel head, for a page to hand its client. */
  static cursor(id: string): Promise<string> {
    return this.getFacadeRoot().cursor(id);
  }

  /** The ChangeFeed channel the run's changes are published to. */
  static channel(id: string): string {
    return this.getFacadeRoot().channel(id);
  }

  /** Times out open runs past their deadline; resolves to how many. */
  static sweep(): Promise<number> {
    return this.getFacadeRoot().sweep();
  }

  /** Deletes runs that ended more than `olderThan` ago; resolves to how many. */
  static prune(olderThan: Duration): Promise<number> {
    return this.getFacadeRoot().prune(olderThan);
  }
}
