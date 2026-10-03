import { LockLostError, type LockStore } from "./LockStore";

export type AcquireOptions = {
  /** The lease, in milliseconds. Default one minute. */
  ttl?: number;
  /**
   * How long to keep trying when the lock is held, in milliseconds. Default
   * `0`: one try.
   */
  wait?: number;
  /**
   * Renew the lease every third of `ttl` until the lock is released. Default
   * `true` for `run`, `false` for `acquire`, whose caller may never release.
   */
  renew?: boolean;
};

export type LockRunResult<T> = { acquired: true; value: T } | { acquired: false };

const DEFAULT_TTL = 60_000;
const WAIT_STEP = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One hold on a lock, from a successful `acquire` until `release` or the end
 * of its lease.
 *
 * `token` is the fencing token: it grows with each new holder of the name, so
 * a write that records it can be refused when an older holder tries to make
 * it late. `fence` does that refusal for writes to the application's own
 * database.
 *
 * `lost` aborts when the hold is known to be gone: a renewal found another
 * holder, or the lease ran out by this process's clock without a successful
 * renewal. The local deadline is measured from just before each request that
 * set the lease, so it always falls before the store's own expiry.
 */
export class HeldLock {
  readonly lost: AbortSignal;
  private readonly controller = new AbortController();
  private deadline: number;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private done = false;

  constructor(
    private readonly store: LockStore,
    readonly name: string,
    readonly owner: string,
    readonly token: number,
    readonly ttl: number,
    requestedAt: number,
  ) {
    this.lost = this.controller.signal;
    this.deadline = requestedAt + ttl;
    this.armExpiry();
  }

  /** Whether the lease has run out by this process's clock, or the hold was lost. */
  get expired(): boolean {
    return this.lost.aborted || performance.now() >= this.deadline;
  }

  /** Renews the lease. `false`, and `lost` aborted, when the hold was already gone. */
  async extend(ttl = this.ttl): Promise<boolean> {
    if (this.lost.aborted) return false;
    const requestedAt = performance.now();
    const ok = await this.store.extend(this.name, this.owner, this.token, ttl);
    if (!ok) {
      this.markLost();
      return false;
    }
    if (this.done) return true;
    this.deadline = Math.max(this.deadline, requestedAt + ttl);
    this.armExpiry();
    return true;
  }

  /** Asks the store whether this hold is still current. */
  async isHeld(): Promise<boolean> {
    if (this.lost.aborted) return false;
    const held = await this.store.held(this.name, this.owner, this.token);
    if (!held) this.markLost();
    return held;
  }

  /**
   * Runs `fn` only while this hold is current, and keeps the lock from
   * changing hands until it settles; rejects with `LockLostError` otherwise.
   * On the database store `fn` runs in a transaction on the store's
   * connection, so ORM writes inside it commit only if the hold was current.
   */
  async fence<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lost.aborted) throw new LockLostError(this.name, this.token);
    try {
      return await this.store.fence(this.name, this.owner, this.token, fn);
    } catch (error) {
      if (error instanceof LockLostError) this.markLost();
      throw error;
    }
  }

  /** Ends the hold. `false` when it had already been lost. */
  async release(): Promise<boolean> {
    this.stop();
    if (this.lost.aborted) return false;
    return this.store.release(this.name, this.owner, this.token);
  }

  /** Renews every third of the lease until `release`. */
  startRenewing() {
    if (this.renewTimer || this.done) return;
    this.renewTimer = setInterval(
      () => {
        this.extend().catch((error) => {
          // Not lost yet: the local deadline still decides, so a store that
          // comes back within the lease keeps the hold.
          console.error(`[gemi] Could not renew the lock "${this.name}".`, error);
        });
      },
      Math.max(1, Math.floor(this.ttl / 3)),
    );
    this.renewTimer.unref?.();
  }

  /** @internal Marks the hold as gone and stops every timer. */
  markLost(detail?: string) {
    this.stop();
    if (!this.lost.aborted) {
      this.controller.abort(new LockLostError(this.name, this.token, detail));
    }
  }

  private stop() {
    this.done = true;
    clearInterval(this.renewTimer);
    clearTimeout(this.expiryTimer);
    this.renewTimer = undefined;
    this.expiryTimer = undefined;
  }

  private armExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => this.markLost("its lease ran out before it was renewed"),
      Math.max(0, this.deadline - performance.now()),
    );
    this.expiryTimer.unref?.();
  }
}

/**
 * Named locks with leases and fencing tokens, over a `LockStore`. The queue
 * builds one over its own storage (`app(QueueManager).locks`), so with the
 * database driver the locks hold across every process sharing the database.
 * The `Lock` facade fronts it.
 */
export class LockManager {
  static token = "locks";

  constructor(readonly store: LockStore) {}

  /** Takes the lock, or resolves `null` if it is held (after `wait`, when given). */
  async acquire(name: string, options: AcquireOptions = {}): Promise<HeldLock | null> {
    const ttl = options.ttl ?? DEFAULT_TTL;
    if (!(ttl > 0))
      throw new Error(`A lock's ttl must be a positive number of milliseconds; got ${ttl}.`);
    const owner = Bun.randomUUIDv7();
    const giveUpAt = performance.now() + Math.max(0, options.wait ?? 0);
    for (;;) {
      const requestedAt = performance.now();
      const token = await this.store.acquire(name, owner, ttl);
      if (token !== null) {
        const lock = new HeldLock(this.store, name, owner, token, ttl, requestedAt);
        if (options.renew) lock.startRenewing();
        return lock;
      }
      const left = giveUpAt - performance.now();
      if (left <= 0) return null;
      await sleep(Math.min(WAIT_STEP, left));
    }
  }

  /**
   * Runs `fn` while holding the lock, renewing the lease as it runs, and
   * releases it after. `{ acquired: false }` when the lock was held.
   *
   * If the hold is lost while `fn` runs, `lock.lost` aborts, and once `fn`
   * settles this rejects with `LockLostError` instead of resolving: the caller
   * must not treat work done without the lock as done under it.
   */
  async run<T>(
    name: string,
    options: AcquireOptions,
    fn: (lock: HeldLock) => Promise<T> | T,
  ): Promise<LockRunResult<T>> {
    const lock = await this.acquire(name, { ...options, renew: options.renew ?? true });
    if (!lock) return { acquired: false };

    let value: T;
    try {
      value = await fn(lock);
    } catch (error) {
      await lock.release().catch(() => {});
      throw error;
    }
    if (lock.expired) {
      lock.markLost();
      throw lock.lost.reason as LockLostError;
    }
    await lock.release();
    return { acquired: true, value };
  }
}
