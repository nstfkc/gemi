/**
 * Where the on/off switches come from.
 *
 * A seam rather than a hardcoded query for two reasons that already exist: the
 * database source cannot run in a unit test without a schema and a connection,
 * and an application that outgrows a table — a control plane, a config service —
 * should not have to fork the evaluator to move.
 *
 * `load()` returns **raw rows**, not booleans. A source fetches; the store
 * interprets, because the store is the half that knows which keys are declared.
 */
export abstract class FeatureFlagSource {
  /**
   * Every row.
   *
   * Returning `[]` means "nothing is switched on", which is a normal state — it
   * is what a fresh database looks like, and every feature is correctly off.
   * **Throwing** means "I could not tell you", which is different: the store
   * keeps serving whatever it last had rather than treating an outage as a mass
   * switch-off.
   */
  abstract load(): Promise<Record<string, unknown>[]>;

  /**
   * Writes one switch — what `Features.set()` calls.
   *
   * Optional. A source that does not implement it is **read-only**, and
   * `Features.set()` refuses with `FeatureSourceReadOnlyError` rather than
   * pretending: a control plane or a config service owns its own writes, and an
   * admin screen that appeared to flip a switch it cannot reach would be worse
   * than one that says so.
   *
   * `actor` is already normalized to a string, or `null` for a write nobody was
   * named for. Return whether it was recorded, so a store with nowhere to put it
   * can be reported once instead of silently dropping every audit entry.
   */
  write?(key: string, active: boolean, meta: FeatureWriteMeta): Promise<FeatureWriteResult>;
}

export interface FeatureWriteMeta {
  /** Who made the change, or `null`. Recorded only by a source that has somewhere to keep it. */
  actor: string | null;
}

export interface FeatureWriteResult {
  /** Whether the source kept `actor`. `false` for a table with no `updatedBy` column. */
  actorRecorded: boolean;
}

/** Raised when the application never added the model this source reads. */
export class FeatureModelMissingError extends Error {
  readonly kind = "FeatureModelMissing";

  constructor(readonly modelName: string) {
    super(
      `No "${modelName}" model is registered, so every feature stays off. Add the model to prisma/schema.prisma and export it from app/models — see docs/feature-flags.md.`,
    );
  }
}

/** Raised by `Features.set()` when the configured source has no `write()`. */
export class FeatureSourceReadOnlyError extends Error {
  readonly kind = "FeatureSourceReadOnly";

  constructor(readonly sourceName: string) {
    super(
      `The feature source (${sourceName}) is read-only, so Features.set() cannot write to it. Change the switch where that source reads from, or give the source a write() method.`,
    );
  }
}
