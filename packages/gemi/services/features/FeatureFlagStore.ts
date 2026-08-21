import type { FeatureRegistry } from "./defineFeature";
import type { FeatureFlagSource } from "./sources/FeatureFlagSource";

export type Warn = (message: string) => void;

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
      // Stale: hand back what we have and refresh behind the request. The
      // `.catch` is required — `load()` already swallows, but an unhandled
      // rejection here would be an unobserved promise on the hot path.
      void this.refresh().catch(() => {});
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
    if (now - this.lastFailureLoggedAt >= this.ttlMs) {
      this.lastFailureLoggedAt = now;
      this.warn(`Could not load feature switches: ${message}`);
    }

    if (this.snapshot) {
      // Keep the data, but move `loadedAt` forward so the next request backs
      // off for a full TTL instead of retrying a down database on every hit.
      this.snapshot = { ...this.snapshot, loadedAt: now };
      return this.snapshot;
    }

    this.snapshot = { active: new Map(), loadedAt: now, unavailable: true };
    return this.snapshot;
  }
}
