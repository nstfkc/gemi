/**
 * Where queued jobs are kept between `Job.dispatch()` and the end of their last
 * attempt.
 *
 * The `QueueManager` owns everything about *running* a job — the registry, the
 * concurrency limit, the hooks, how many attempts a job gets and how long to
 * wait between them. A driver owns only the *record*: what is waiting, who has
 * claimed what, and until when. That split is what lets a driver be swapped
 * without a job noticing, and it is why nothing in here knows about `Job`.
 *
 * ### The claim model
 *
 * A job is **claimed** rather than popped. `claim` hands it out with a lease of
 * `visibilityTimeoutMs`; while the lease holds nobody else is given it, and the
 * holder ends it with `complete` or `fail`, or extends it with `heartbeat`. A
 * lease that simply runs out — the process holding it was killed mid-run — makes
 * the job claimable again, by any process sharing the driver's storage. That is
 * the whole of crash recovery: nothing is replayed on boot, a new process just
 * claims what the dead one left behind once its leases expire.
 *
 * Every claim counts as an attempt, including one whose process died before it
 * could report. Otherwise a job that reliably kills its process would be
 * reclaimed forever; counted, it reaches `maxAttempts` and the manager
 * dead-letters it on the next claim without running it again.
 *
 * ### Stale claims
 *
 * The manager passes the claimed job back to `complete`, `fail` and
 * `heartbeat`, not just its id, so a driver can tell a current claim from a stale
 * one by `attempt`. A process can lose its lease and still finish — it was slow,
 * not dead — after the job has been reclaimed elsewhere. Its report must not end
 * the newer claim, so a report whose `attempt` is not the job's current one is
 * ignored.
 *
 * ### Time
 *
 * Every duration crosses this interface as a *relative* number of milliseconds,
 * never as a timestamp. A driver shared by several machines should measure
 * leases and delays on one clock — its database's, say — and a timestamp
 * computed on the dispatching machine would carry that machine's skew into
 * every other one.
 */
export interface QueueDriver {
  /**
   * Records a job and returns its id. The job is claimable once `delayMs` has
   * passed (immediately when it is absent or zero). Resolving means the job is
   * durable to whatever degree the driver is; the memory driver is not at all.
   */
  enqueue(job: EnqueueJob): Promise<string>;

  /**
   * Leases up to `limit` claimable jobs, oldest first, each for
   * `visibilityTimeoutMs`, and returns them with `attempt` already incremented.
   * A job is claimable when it is waiting and due, or when its previous lease
   * has run out. Two concurrent calls — from this process or another — are never
   * handed the same job.
   */
  claim(limit: number, options: ClaimOptions): Promise<ClaimedJob[]>;

  /** Ends a claim successfully. The job is never claimed again. */
  complete(job: ClaimedJob): Promise<void>;

  /**
   * Ends a claim unsuccessfully. With a `retryInMs`, the job becomes claimable
   * again after that long, keeping its attempt count. With `retryInMs: null`
   * it is dead-lettered: terminal, never claimed again. What a driver keeps of
   * a dead-lettered job is its own business; the memory driver keeps nothing.
   */
  fail(job: ClaimedJob, failure: JobFailure): Promise<void>;

  /**
   * Extends the leases of jobs still being run by `visibilityTimeoutMs` from
   * now. Optional: a driver whose leases never expire has nothing to extend.
   */
  heartbeat?(jobs: ClaimedJob[], options: ClaimOptions): Promise<void>;

  /**
   * Calls `wake` whenever a job may have become claimable, and returns the
   * unsubscribe. Optional: a driver without it is polled every
   * `pollInterval` instead. A spurious wake is harmless — the manager claims
   * and finds nothing — but a missed one leaves a job waiting, so a driver
   * that cannot guarantee it should leave this out and be polled.
   */
  subscribe?(wake: () => void): () => void;
}

export type EnqueueJob = {
  /** The job's registered name — its class's `static name`. */
  name: string;
  /** The `run` arguments, as the JSON string `Job.dispatch` serialised. */
  args: string;
  delayMs?: number;
};

export type ClaimOptions = {
  visibilityTimeoutMs: number;
};

export type ClaimedJob = {
  id: string;
  name: string;
  args: string;
  /**
   * Which attempt this claim is, counting from 1. Incremented by `claim`, so a
   * lease that expired without a report still used one up.
   */
  attempt: number;
  /** When `enqueue` recorded it, in epoch milliseconds. */
  createdAt: number;
};

export type JobFailure = {
  /** Something a human can read in whatever the driver keeps. */
  error: string;
  /** Milliseconds until the retry is claimable, or `null` to dead-letter. */
  retryInMs: number | null;
};
