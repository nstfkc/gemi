import type { FeatureRegistry } from "./defineFeature";
import type { FeatureFlagSource } from "./sources/FeatureFlagSource";

export type Warn = (message: string) => void;

/**
 * A reload asked for by `invalidate()` did not happen.
 *
 * Only `invalidate()` raises this. The switches in memory are whatever they were
 * before — quite possibly older than the write the caller just made — so a
 * handler that catches it should say so rather than render the list as fact.
 */
export class FeatureReloadError extends Error {
  readonly kind = "FeatureReloadFailed";

  constructor(readonly cause: unknown) {
    super(
      `Could not reload feature switches after a write, so the cached switches may still predate it: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export interface FlagSnapshot {
  /** `key -> active`. A key absent from the map has no row, and is off. */
  active: Map<string, boolean>;
  loadedAt: number;
  /** True only while nothing has *ever* loaded successfully. */
  unavailable: boolean;
}

/**
 * The process-local cache of on/off switches.
 *
 * gemi has no `Cache` facade, and this does not add one — a general cache
 * abstraction is a much larger design, and coupling features to a hypothetical
 * version of it would block both.
 *
 * Three properties, each load-bearing:
 *
 * **Stale-while-revalidate.** After the first load, `get()` returns an
 * already-resolved snapshot and refreshes in the background. No request ever
 * waits on the database for a feature. This is what makes evaluating every
 * feature on every request affordable, and it is why the manager can be eager.
 *
 * **Single-flight.** A cold start under load must not issue one query per
 * in-flight request, so concurrent refreshes share one promise.
 *
 * **A failed refresh keeps the last good data.** An outage must not read as
 * "every feature switched itself off" — that is a config change nobody made,
 * applied to production, at the exact moment something else is already broken.
 */
export class FeatureFlagStore {
  private snapshot: FlagSnapshot | null = null;
  private inflight: Promise<FlagSnapshot> | null = null;
  /** Rate-limits the "could not load" line to once per TTL window. */
  private lastFailureLoggedAt = 0;
  /**
   * Counts *successful* loads, so a caller can tell whether the reload it asked
   * for actually happened. Nothing else can: `load()` swallows, and both
   * outcomes hand back a snapshot.
   */
  private generation = 0;
  /** The most recent load failure, for a caller that wants to report it. */
  private lastError: unknown = null;
  /**
   * Do not attempt another background load before this.
   *
   * The backoff after a failure used to be expressed by moving the kept
   * snapshot's `loadedAt` forward, which made a stale snapshot claim to be
   * freshly loaded — so nothing downstream could tell how old the switches
   * actually were, and a failed `invalidate()` silently pinned pre-write data
   * for a further full TTL. The clock and the timestamp are two facts; they are
   * now two fields.
   */
  private retryAfter = 0;

  constructor(
    private readonly source: FeatureFlagSource,
    private readonly declared: FeatureRegistry,
    private readonly ttlMs: number,
    private readonly warn: Warn = () => {},
  ) {}

  /** Never rejects. Callers always get a snapshot, possibly an empty one. */
  async get(): Promise<FlagSnapshot> {
    const current = this.snapshot;

    if (current && Date.now() - current.loadedAt < this.ttlMs) {
      return current;
    }
    if (current) {
      // Stale: hand back what we have and refresh behind the request, unless a
      // recent failure has us backing off — a down database must not be asked
      // again on every read. The `.catch` is required: `load()` already
      // swallows, but an unhandled rejection here would be an unobserved promise
      // on the hot path.
      if (Date.now() >= this.retryAfter) void this.refresh().catch(() => {});
      return current;
    }

    return await this.refresh();
  }

  /** Forces a reload now, sharing one query across concurrent callers. */
  refresh(): Promise<FlagSnapshot> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Reloads for a caller that has just written to the table and needs to see
   * its own write.
   *
   * Not the same as `refresh()`, and the difference is the whole point.
   * `refresh()` joins whatever load is already in flight — that is what keeps a
   * cold start under load down to one query — but a load already in flight
   * issued its query at some earlier moment, possibly before the write
   * committed. An admin that toggled a row and called `refresh()` could
   * therefore be handed, and return to the browser, a snapshot that predates the
   * toggle: the screen says the switch is still off a moment after flipping it.
   *
   * So this waits for that load to settle and starts a fresh one behind it. Any
   * load created after that point was created after this call, and so queries
   * after the write. The extra query is paid on an operator action, not on the
   * request path.
   *
   * **Throws when the reload failed.** This is the one call in the store that
   * does. Everywhere else a failure means "keep serving what we have", which is
   * right for evaluation and wrong here: the caller has already written to the
   * table and is about to show somebody the result, and a swallowed failure
   * would hand them the pre-write switches with nothing to distinguish that from
   * success — worse than never calling this at all.
   */
  async invalidate(): Promise<FlagSnapshot> {
    // `catch` because `load()` never rejects today, but a rejection here would
    // skip the reload entirely and leave the stale snapshot in place — the exact
    // failure this method exists to prevent.
    await this.inflight?.catch(() => {});

    // Read *after* the await. The load we just waited out may have succeeded,
    // and that success is not ours — it queried before this call, and possibly
    // before the write.
    const generation = this.generation;
    const snapshot = await this.refresh();

    if (this.generation === generation) {
      throw new FeatureReloadError(this.lastError);
    }

    return snapshot;
  }

  /** What is cached right now, without triggering a load. */
  peek(): FlagSnapshot | null {
    return this.snapshot;
  }

  private async load(): Promise<FlagSnapshot> {
    try {
      const rows = await this.source.load();
      this.snapshot = {
        active: this.readSwitches(rows),
        loadedAt: Date.now(),
        unavailable: false,
      };
      this.generation++;
      this.lastError = null;
      this.retryAfter = 0;
      return this.snapshot;
    } catch (error) {
      return this.handleFailure(error);
    }
  }

  /**
   * Rows in, `key -> active` out.
   *
   * The row is treated as hostile input — not because anyone expects it to be
   * malformed, but because it is the one part of this system nobody reviews
   * before it reaches production. A bad row is logged and skipped, never thrown:
   * a typo in a column must not take the process down at boot.
   */
  private readSwitches(rows: Record<string, unknown>[]): Map<string, boolean> {
    const active = new Map<string, boolean>();

    for (const row of rows ?? []) {
      const key = typeof row?.key === "string" ? row.key : null;
      if (!key) {
        this.warn("Ignoring a feature row with no `key`.");
        continue;
      }

      if (!(key in this.declared)) {
        // A row for a feature nobody declares is usually one that was removed
        // from the code and left in the table, which is harmless — so this warns
        // rather than throws. It is also the signal that the row is now litter.
        this.warn(
          `Feature row "${key}" is not declared in app/features, so it is ignored. Delete the row, or declare the feature.`,
        );
        continue;
      }

      active.set(key, row.active === true);
    }

    return active;
  }

  private handleFailure(error: unknown): FlagSnapshot {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    this.lastError = error;
    // Back off for a full TTL rather than retrying a down database on every hit.
    // `loadedAt` is deliberately left alone: these switches are as old as they
    // were a moment ago, and saying otherwise is what let a failed `invalidate()`
    // pass pre-write data off as freshly loaded.
    this.retryAfter = now + this.ttlMs;

    if (now - this.lastFailureLoggedAt >= this.ttlMs) {
      this.lastFailureLoggedAt = now;
      this.warn(`Could not load feature switches: ${message}`);
    }

    if (this.snapshot) return this.snapshot;

    this.snapshot = { active: new Map(), loadedAt: now, unavailable: true };
    return this.snapshot;
  }
}
