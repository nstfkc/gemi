import {
  type AcquireOptions,
  type HeldLock,
  LockManager,
  type LockRunResult,
} from "../services/lock/LockManager";
import { Facade } from "./Facade";

/**
 * Named locks with a lease and a fencing token, held across every process
 * that shares the queue's storage — with the database queue driver, its
 * `gemi_locks` table. No Redis needed.
 *
 * ```ts
 * const result = await Lock.run("usage-snapshot", { ttl: 60_000 }, async (lock) => {
 *   const rows = await heavyQuery({ signal: lock.lost });
 *   // Commits only if this process still holds the lock.
 *   await lock.fence(() => Snapshot.upsert({ ... }));
 * });
 * if (!result.acquired) return "already running";
 * ```
 */
export class Lock extends Facade {
  static getFacadeAccessor() {
    return LockManager;
  }

  /** Runs `fn` holding the lock, renewing its lease; `{ acquired: false }` if it is held. */
  static run<T>(
    name: string,
    options: AcquireOptions,
    fn: (lock: HeldLock) => Promise<T> | T,
  ): Promise<LockRunResult<T>> {
    return this.getFacadeRoot().run(name, options, fn);
  }

  /** Takes the lock, or resolves `null` if it is held. Release it yourself. */
  static acquire(name: string, options: AcquireOptions = {}): Promise<HeldLock | null> {
    return this.getFacadeRoot().acquire(name, options);
  }
}
