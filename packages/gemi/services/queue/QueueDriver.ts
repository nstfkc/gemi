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
   * Whether an `enqueue` made now, from the caller's async context, would be
   * written inside the ORM transaction that context has open — so that the
   * job commits with the transaction's rows, rolls back with them, and no
   * claimer anywhere can see it before the commit. Optional, and `false` when
   * absent.
   *
   * The manager asks before every dispatch. A driver that answers `true` is
   * handed the job at once and is trusted to have joined; for any other, a
   * dispatch inside a transaction is held by the manager and enqueued after
   * the commit, and dropped if the transaction rolls back. The second is
   * weaker in one way only: a process that dies between the commit and the
   * enqueue loses the job.
   *
   * Answer `true` only when every claim — this process's included — reads
   * through a different connection than the transaction's. A driver whose
   * claims share the transaction's connection would see the uncommitted job
   * and could run it before the commit, which is the thing being prevented.
   */
  joinsTransaction?(): boolean;

  /**
   * Leases up to `limit` claimable jobs, each for `visibilityTimeoutMs`, and
   * returns them with `attempt` already incremented. A job is claimable when
   * it is waiting and due, or when its previous lease has run out. Two
   * concurrent calls — from this process or another — are never handed the same
   * job.
   *
   * Oldest first, and *oldest* means the time a job became claimable, not the
   * time it was enqueued: a job's due moment, which is its `createdAt` plus
   * `delayMs` and then the end of each retry's backoff. The two only differ
   * once a delay or a retry is in play, and then they differ a lot — ordering
   * by creation time lets a job that asked to wait five minutes jump the queue
   * ahead of everything enqueued while it waited. The contract suite pins it.
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
   * Ends a claim without counting it: the job becomes claimable again after
   * `retryInMs`, with `attempt` back where it was before this claim, so the
   * next claimer gets the attempt this one never made. Like `complete` and
   * `fail`, a report from a stale claim is ignored.
   *
   * The manager releases a job it has no class for, on a driver other
   * processes share: during a blue/green ramp that is a job only the other
   * release knows, and a replica running that release should have it. Through
   * `fail` the refusal would cost the job an attempt each time an old replica
   * picked it up, and one that the other release gives a single attempt would
   * be dead-lettered without ever having run.
   */
  release(job: ClaimedJob, release: JobRelease): Promise<void>;

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
  /**
   * The id to record the job under, which `enqueue` then resolves to. Given
   * only for a dispatch the manager held until a transaction committed: that
   * dispatch has already resolved, inside the transaction, to the id the job
   * was going to have, and a driver that picked its own would make that id
   * name nothing. Absent, the driver chooses.
   */
  id?: string;
};

export type ClaimOptions = {
  visibilityTimeoutMs: number;
  /**
   * The names the claiming process has a class for, from its registry. A
   * driver that can filter by name hands out a job under any other name only
   * once it has been claimable for `graceMs` — while it has been waiting for a
   * shorter time than that, it is left for a process that knows the name.
   *
   * This is what keeps a blue/green ramp from losing jobs. Both releases claim
   * from one table for several minutes, and a job only the new release has
   * would otherwise be claimed by an old replica, which can do nothing with it.
   * Past `graceMs` the name is taken to be gone rather than deployed
   * elsewhere, and the job is handed out so the manager can dead-letter it —
   * otherwise a job whose class was deleted would wait in storage forever,
   * with nothing anywhere saying so.
   *
   * *Claimable* for a waiting job is from when it became due; for a leased one
   * whose lease ran out, from when the lease did. `graceMs` of `Infinity`
   * never hands out an unknown name.
   *
   * Optional to honour. A driver that ignores it hands out every name, and the
   * manager releases what it cannot run until the same grace has passed since
   * the job was enqueued. The memory driver ignores it on purpose: nothing
   * else can run its jobs, so an unknown name there is dead-lettered at once,
   * with the line on stderr that says why.
   */
  registered?: { names: readonly string[]; graceMs: number };
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

export type JobRelease = {
  /** Milliseconds until the job is claimable again. */
  retryInMs: number;
};

export type JobFailure = {
  /** Something a human can read in whatever the driver keeps. */
  error: string;
  /** Milliseconds until the retry is claimable, or `null` to dead-letter. */
  retryInMs: number | null;
};
