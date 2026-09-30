import * as registry from "../../../orm/registry";
import {
  FeatureFlagSource,
  FeatureModelMissingError,
  type FeatureWriteMeta,
  type FeatureWriteResult,
} from "./FeatureFlagSource";

/**
 * Reads the application's `FeatureFlag` table — one row per feature, carrying
 * one meaningful column.
 *
 * The model is resolved from the ORM registry **by name, at call time**, the way
 * `auth/UserProvider` resolves `User`. The framework cannot import a class the
 * application generates, and resolving lazily also means constructing this
 * source does not require the app's models to have been imported yet — only
 * loading does.
 */
export class DatabaseFeatureFlagSource extends FeatureFlagSource {
  constructor(readonly modelName: string = "FeatureFlag") {
    super();
  }

  /** Whether the application has registered the model at all. */
  get available(): boolean {
    return registry.has(this.modelName);
  }

  async load(): Promise<Record<string, unknown>[]> {
    if (!this.available) {
      throw new FeatureModelMissingError(this.modelName);
    }

    const model = registry.get<any>(this.modelName);

    // `asSystem` for the same reason auth uses it: features are read before
    // there is a user — on an anonymous page load, in a cron tick — and a policy
    // that denies by default would turn "nobody is signed in" into "no rows",
    // which silently switches every feature off for logged-out traffic.
    return await model.asSystem(() => model.findMany());
  }

  /**
   * Upserts the row for `key`.
   *
   * `upsert`, not `update`: a feature that has been deployed but never switched
   * on has no row at all, and that is exactly the state an admin screen exists
   * to change.
   *
   * The actor goes into an `updatedBy` column **when the model has one**, and is
   * otherwise not recorded. The column is optional so that adding `Features.set`
   * did not become a migration every app owes. When it exists it is always
   * written — `null` for a write with no actor — because leaving the previous
   * value in place would credit the last named person with a change they did
   * not make.
   */
  async write(key: string, active: boolean, meta: FeatureWriteMeta): Promise<FeatureWriteResult> {
    if (!this.available) {
      throw new FeatureModelMissingError(this.modelName);
    }

    const model = registry.get<any>(this.modelName);
    const actorRecorded = this.hasActorColumn(model);
    const data: Record<string, unknown> = { active };
    if (actorRecorded) data.updatedBy = meta.actor;

    // `asSystem` for the same reason `load()` uses it: the table is global
    // configuration, and a policy that denied the write would leave the admin
    // with an error about tenancy on a row that has none.
    await model.asSystem(() =>
      model.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      }),
    );

    return { actorRecorded };
  }

  private hasActorColumn(model: any): boolean {
    const field = model?.$schema?.fields?.updatedBy;
    return field !== undefined && field.type === "String";
  }
}
