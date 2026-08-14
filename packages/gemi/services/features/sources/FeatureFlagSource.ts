/**
 * Where flag rows come from.
 *
 * A seam rather than a hardcoded query for two reasons that already exist: the
 * database source cannot run in a unit test without a schema and a connection,
 * and an application that outgrows a table (an external provider, a JSON blob on
 * object storage) should not have to fork the evaluator to move.
 *
 * `load()` returns **raw rows**, not definitions. Normalization needs the code
 * declarations to know a flag's default and its allowed values, and a source has
 * no business knowing about those — it fetches, the store interprets.
 */
export abstract class FeatureFlagSource {
  /**
   * Every non-archived row.
   *
   * Returning `[]` means "no flags are configured", which is a normal state and
   * resolves every flag to its declared default. **Throwing** means "I could not
   * tell you", which is different: the store keeps serving whatever it last had
   * rather than treating an outage as a mass flag reset.
   */
  abstract load(): Promise<Record<string, unknown>[]>;
}

/** Raised when the application never added the model this source reads. */
export class FeatureModelMissingError extends Error {
  readonly kind = "FeatureModelMissing";

  constructor(readonly modelName: string) {
    super(
      `No "${modelName}" model is registered, so feature flags fall back to the defaults declared in app/features. Add the model to prisma/schema.prisma and export it from app/models — see docs/feature-flags.md.`,
    );
  }
}
