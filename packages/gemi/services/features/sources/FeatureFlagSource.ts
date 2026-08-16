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
