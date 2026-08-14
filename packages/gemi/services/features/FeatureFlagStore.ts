import type { FeatureFlag } from "../../http/FeatureRouter";
import { normalizeFlag, type Warn } from "./normalize";
import type { FeatureFlagSource } from "./sources/FeatureFlagSource";
import type { FeatureFlagDefinition, FlagValue } from "./types";

export interface FlagSnapshot {
  flags: Map<string, FeatureFlagDefinition>;
  loadedAt: number;
  /** True only while nothing has *ever* loaded successfully. */
  unavailable: boolean;
}

/**
 * The process-local cache of flag definitions.
 *
 * gemi has no `Cache` facade, and this does not add one — a general cache
 * abstraction is a much larger design, and coupling flags to a hypothetical
 * version of it would block both.
 *
 * Three properties, each load-bearing:
 *
 * **Stale-while-revalidate.** After the first load, `get()` returns an
 * already-resolved snapshot and refreshes in the background. No request ever
 * waits on the database for a flag. This is what makes evaluating every flag on
 * every request affordable, and it is why the manager can be eager.
 *
 * **Single-flight.** A cold start under load must not issue one query per
 * in-flight request, so concurrent refreshes share one promise.
 *
 * **A failed refresh keeps the last good data.** An outage must not read as
 * "every flag reverted to its default" — that is a config change nobody made,
 * applied to production, at the exact moment something else is already broken.
 */
export class FeatureFlagStore {
  private snapshot: FlagSnapshot | null = null;
  private inflight: Promise<FlagSnapshot> | null = null;
  /** Rate-limits the "could not load" line to once per TTL window. */
  private lastFailureLoggedAt = 0;

  constructor(
    private readonly source: FeatureFlagSource,
    private readonly declared: Map<string, FeatureFlag<FlagValue>>,
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
        flags: this.buildDefinitions(rows),
        loadedAt: Date.now(),
        unavailable: false,
      };
      return this.snapshot;
    } catch (error) {
      return this.handleFailure(error);
    }
  }

  private buildDefinitions(
    rows: Record<string, unknown>[],
  ): Map<string, FeatureFlagDefinition> {
    const flags = new Map<string, FeatureFlagDefinition>();

    for (const row of rows ?? []) {
      const key = typeof row?.key === "string" ? row.key : null;
      if (!key) {
        this.warn("Ignoring a feature flag row with no `key`.");
        continue;
      }

      const declaration = this.declared.get(key);
      if (!declaration) {
        // A row for a flag nobody declares cannot be evaluated — there is no
        // default and no allowed set to check it against. Usually a flag that
        // was removed from the code and left in the table, which is harmless,
        // so this warns rather than throws.
        this.warn(
          `Feature flag row "${key}" is not declared in app/features, so it is ignored. Remove the row, or declare the flag.`,
        );
        continue;
      }

      const definition = normalizeFlag(row, declaration, this.warn);
      if (definition) flags.set(definition.key, definition);
    }

    return flags;
  }

  private handleFailure(error: unknown): FlagSnapshot {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (now - this.lastFailureLoggedAt >= this.ttlMs) {
      this.lastFailureLoggedAt = now;
      this.warn(`Could not load feature flags: ${message}`);
    }

    if (this.snapshot) {
      // Keep the data, but move `loadedAt` forward so the next request backs
      // off for a full TTL instead of retrying a down database on every hit.
      this.snapshot = { ...this.snapshot, loadedAt: now };
      return this.snapshot;
    }

    this.snapshot = { flags: new Map(), loadedAt: now, unavailable: true };
    return this.snapshot;
  }
}
