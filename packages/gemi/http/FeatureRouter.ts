import type { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";

/**
 * What a flag can resolve to.
 *
 * Deliberately flat — no objects, no arrays. Two reasons, and both are about the
 * payload rather than the type: every client-visible flag is embedded in the
 * HTML of every page, so a rich value is bytes on every request forever; and a
 * flag whose value is a config object is a config system wearing a flag's
 * clothes, which wants a different lifecycle (versioned, reviewed) than a thing
 * you flip at 2am.
 */
export type FlagValue = boolean | string | number | null;

/**
 * One declared flag: its value type, its default, and the metadata that is not
 * the database's to own.
 *
 * The **default** lives here rather than in a row because it is the answer when
 * there is no row — a fresh database, a key nobody has configured yet, a flag
 * whose row was deleted. Putting it in code means the application always has a
 * defined behaviour and the flags table is purely additive.
 */
export class FeatureFlag<V extends FlagValue> {
  /**
   * Structural marker. The type walk below distinguishes a flag from a nested
   * router, and two classes with no distinguishing members are assignable to
   * each other — so without this a `FeatureRouter` subclass would match
   * `FeatureFlag` and the inference would silently produce garbage.
   */
  readonly __brand = "FeatureFlag" as const;

  description?: string;

  /**
   * Kept out of the SSR payload when true, but still evaluated on the server.
   *
   * The reason is that flag *keys* are public: every client-visible key appears
   * in the HTML of every page, so a flag named for an unannounced feature
   * announces it. This is the answer for anything whose existence is the secret.
   */
  isServerOnly = false;

  constructor(
    readonly defaultValue: V,
    /**
     * The values a rule is allowed to serve, for `variant` flags. A rule serving
     * something outside this set is a typo or a stale rule, and is rejected at
     * normalization rather than handed to a `switch` that has no branch for it.
     */
    readonly allowed?: readonly V[],
  ) {}

  describe(description: string): this {
    this.description = description;
    return this;
  }

  serverOnly(): this {
    this.isServerOnly = true;
    return this;
  }
}

export type FeatureDefinitions = Record<
  string,
  FeatureFlag<any> | (new () => FeatureRouter)
>;

/**
 * Where an application declares its feature flags.
 *
 * ```ts
 * // app/features/index.ts
 * export default class extends FeatureRouter {
 *   features = {
 *     "new-checkout": this.boolean(false),
 *     "pricing-page": this.variant(["a", "b", "control"], "control"),
 *     "billing/": BillingFeatures,
 *   };
 * }
 * ```
 *
 * The shape mirrors `ViewRouter` and `ApiRouter` on purpose: a nested class
 * under a key composes, and the whole tree is walked at the type level to build
 * the `Features` interface that types `useFeature` and `Features.enabled`.
 *
 * ## Do not annotate `features`
 *
 * Write `features = { ... }`, never `features: FeatureDefinitions = { ... }`.
 * The annotation widens the object's literal keys to the index signature above,
 * `CreateFeatures` then has nothing specific to walk, and every flag key becomes
 * an untyped `string`. There is no error — the inference just quietly produces
 * nothing, and `useFeature("typo")` starts compiling. `ViewRouter.routes` has
 * the same property for the same reason.
 *
 * ## Code declares, the database controls
 *
 * A flag's key, value type and default are here, in a file that is reviewed and
 * deployed. Whether it is on, and who it is on *for*, live in the `FeatureFlag`
 * table and change without a deploy. Adding a flag is therefore a release;
 * flipping one is not.
 */
export class FeatureRouter {
  features: FeatureDefinitions = {};

  /** An on/off flag. */
  boolean(defaultValue = false): FeatureFlag<boolean> {
    return new FeatureFlag<boolean>(defaultValue);
  }

  /** A numeric flag — a limit, a threshold, a batch size. */
  number(defaultValue: number): FeatureFlag<number> {
    return new FeatureFlag<number>(defaultValue);
  }

  /** A free-form string flag. Prefer `variant` when the set is known. */
  string(defaultValue: string): FeatureFlag<string> {
    return new FeatureFlag<string>(defaultValue);
  }

  /**
   * A multivariate flag over a closed set.
   *
   * `const` on the type parameter is what preserves the literals: without it
   * `["a", "b"]` widens to `string[]`, the flag's type becomes `string`, and a
   * `switch` over it loses exhaustiveness — which is most of the reason to
   * declare the set at all.
   */
  variant<const T extends readonly string[]>(
    values: T,
    defaultValue: T[number],
  ): FeatureFlag<T[number]> {
    return new FeatureFlag<T[number]>(defaultValue, values);
  }
}

type JoinKey<Prefix extends PropertyKey, K extends PropertyKey> =
  `${Prefix & string}${K & string}`;

type FeaturesParser<
  T,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends new () => FeatureRouter
    ? FeaturesParser<InstanceType<T[K]>["features"], JoinKey<Prefix, K>>
    : T[K] extends FeatureFlag<infer V>
      ? KeyAndValue<JoinKey<Prefix, K>, V>
      : never
  : never;

/**
 * The `{ key: valueType }` map an application's `FeatureRouter` describes.
 *
 * Consumed through module augmentation, so `useFeature` and the `Features`
 * facade are typed against the app's own flags:
 *
 * ```ts
 * declare module "gemi/client" {
 *   export interface Features extends CreateFeatures<InstanceType<typeof AppFeatures>> {}
 * }
 * ```
 */
export type CreateFeatures<T extends FeatureRouter> = KeyAndValueToObject<
  FeaturesParser<T["features"]>
>;

/**
 * The runtime counterpart of `CreateFeatures`: the same walk, producing the flat
 * `key -> FeatureFlag` map the evaluator needs for defaults, allowed values and
 * the server-only exclusion.
 *
 * Kept beside the type it mirrors so the two cannot drift — a key the types
 * promise and the runtime does not produce is a flag that types fine and always
 * returns its default.
 */
export function flattenFeatures(
  router: FeatureRouter,
  prefix = "",
  out: Map<string, FeatureFlag<FlagValue>> = new Map(),
): Map<string, FeatureFlag<FlagValue>> {
  for (const [key, value] of Object.entries(router.features ?? {})) {
    if (value instanceof FeatureFlag) {
      const flagKey = `${prefix}${key}`;
      if (out.has(flagKey)) {
        throw new Error(
          `Duplicate feature flag key "${flagKey}". Two declarations resolve to the same key; nested router prefixes are concatenated, so "a/" + "b" and "a/b" collide.`,
        );
      }
      out.set(flagKey, value);
      continue;
    }
    if (typeof value === "function") {
      flattenFeatures(new (value as new () => FeatureRouter)(), `${prefix}${key}`, out);
    }
  }
  return out;
}
