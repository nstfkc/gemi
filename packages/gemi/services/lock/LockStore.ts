/**
 * Where locks are kept: one record per lock name, with the current holder, a
 * fencing token and a lease.
 *
 * ### The model
 *
 * A lock is held by an **owner** (a random id per acquisition, or a job's id)
 * until its **lease** runs out or the owner releases it. Every successful
 * `acquire` raises the name's **token** by one, so tokens only grow per name and
 * a newer holder always has a larger one than any older holder. A store never
 * forgets a name on release, which is what keeps the token growing; `prune`
 * (on a store that has it) removes names idle for long enough.
 *
 * A lease that runs out is lost, even if nobody has taken the lock since:
 * `extend`, `held` and `fence` all refuse it. That is the rule that makes the
 * token mean something. A holder whose process stalled past its lease cannot
 * renew its way back in after another process may have started the same work.
 *
 * ### Time
 *
 * Durations cross this interface as relative milliseconds, as they do for
 * `QueueDriver`, so a store shared between machines can measure every lease on
 * one clock, its own.
 */
export interface LockStore {
  /**
   * Takes `name` for `owner` for `ttlMs`, if nobody holds it or the holder's
   * lease ran out, and resolves to the new fencing token. `null` when it is
   * held. Two concurrent calls, from any processes sharing the store, never
   * both succeed.
   */
  acquire(name: string, owner: string, ttlMs: number): Promise<number | null>;

  /**
   * Renews a lease to `ttlMs` from now, and resolves to whether `owner` still
   * held it with `token`. A lease that already ran out is not renewed.
   */
  extend(name: string, owner: string, token: number, ttlMs: number): Promise<boolean>;

  /**
   * Ends a hold, and resolves to whether `owner` held it (with `token`, when
   * given) and its lease had not run out. Releasing a lock someone else now
   * holds does nothing.
   */
  release(name: string, owner: string, token?: number): Promise<boolean>;

  /** The current holder, or `null` when the lock is free or its lease ran out. */
  holder(name: string): Promise<{ owner: string; token: number } | null>;

  /** Whether `owner` still holds `name` with `token`, its lease running. */
  held(name: string, owner: string, token: number): Promise<boolean>;

  /**
   * Raises a counter kept under `name` to `value` if it is below it, and
   * resolves to whether it did. For "once per tick across instances": every
   * instance advances to the tick's number and only the first one gets `true`.
   * A name used here must not also be used with `acquire`.
   */
  advance(name: string, value: number): Promise<boolean>;

  /**
   * Runs `fn` only if `owner` still holds `name` with `token`, and keeps the
   * lock from changing hands until `fn` settles. Rejects with `LockLostError`
   * when the hold is gone. On the database store this is a transaction that
   * locks the lock's row first, so writes `fn` makes through the ORM on the
   * same connection commit only while the hold is current, and a new holder's
   * `acquire` waits for that commit.
   */
  fence<T>(name: string, owner: string, token: number, fn: () => Promise<T>): Promise<T>;
}

/** The hold on a lock ended before the work it guarded did. */
export class LockLostError extends Error {
  constructor(
    readonly lock: string,
    readonly token: number,
    detail = "its lease ran out or another holder took it",
  ) {
    super(`Lost the lock "${lock}" (token ${token}): ${detail}.`);
    this.name = "LockLostError";
  }
}
