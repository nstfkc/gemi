import type { FeatureContext } from "./types";

/**
 * Decides a feature for one context, ahead of the percentage rollout.
 *
 * Return `true` or `false` to answer outright. Return nothing — `undefined` —
 * to abstain, which falls through to `rollout`. The three-way return is what
 * lets one function express "always on for staff, always off for free plans,
 * everybody else takes their chances" without a second mechanism.
 *
 * Synchronous on purpose. This runs once per feature per request inside the
 * render path, and an `async` signature is an invitation to put a query there —
 * at which point every page load pays for every declared feature. Anything it
 * needs should already be on the context: `user` is the resolved session user,
 * and `attributes` is whatever `app/config/features.ts` puts there.
 */
export type FeatureAttribution = (ctx: FeatureContext) => boolean | undefined | void;

export interface FeatureOptions {
  /** Free text for humans — an admin list, a CLI, a code reader. */
  describe?: string;

  /**
   * Percentage of subjects the feature is on for, `0`–`100`.
   *
   * Applied only when `when` abstains. Omitting it means "everyone", which is
   * the common case: most features are shipped dark and then turned on for all
   * traffic at once.
   *
   * The assignment is a pure function of the subject, so it is stable without
   * being stored anywhere, and raising the number only ever adds subjects. See
   * `bucket.ts`.
   */
  rollout?: number;

  /** Targeting, evaluated before `rollout`. */
  when?: FeatureAttribution;

  /**
   * Keeps the feature out of the SSR payload while still evaluating it on the
   * server.
   *
   * Feature *keys* are public: every client-visible key is embedded in the HTML
   * of every page, so a key named after an unannounced product announces it.
   * This is the answer whenever the existence of the feature is the secret.
   */
  serverOnly?: boolean;

  /**
   * Overrides the bucketing salt, which is the feature's own key by default.
   *
   * Two reasons to set it. Changing it deliberately re-randomises who is in the
   * rollout — the way to start a second experiment on the same surface without
   * reusing the first one's cohort. And sharing it between two features holds
   * their populations together, so a rollout split across a client and a server
   * feature lands on the same subjects.
   */
  salt?: string;
}

/**
 * One declared feature.
 *
 * The declaration owns the key, the targeting and the rollout. The database owns
 * one thing only — whether the feature is switched on at all — which is what
 * makes shipping a feature a deploy and turning it on an `UPDATE`.
 */
export class Feature {
  readonly describe?: string;
  readonly rollout?: number;
  readonly when?: FeatureAttribution;
  readonly serverOnly: boolean;
  readonly salt?: string;

  constructor(options: FeatureOptions = {}) {
    // Thrown rather than clamped or warned. This is application source, read at
    // boot, and a nonsense rollout is a typo somebody can fix in the same minute
    // they see the stack trace. Database rows get the opposite treatment for the
    // opposite reason — nobody is standing next to those when they are wrong.
    if (options.rollout !== undefined) {
      const { rollout } = options;
      if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) {
        throw new Error(
          `A feature's \`rollout\` must be a number between 0 and 100, received ${String(rollout)}.`,
        );
      }
    }

    this.describe = options.describe;
    this.rollout = options.rollout;
    this.when = options.when;
    this.serverOnly = options.serverOnly ?? false;
    this.salt = options.salt;
  }
}

/**
 * Declares a feature.
 *
 * ```ts
 * // app/features/index.ts
 * import { defineFeature } from "gemi/services";
 *
 * export default {
 *   // On for everyone, once switched on in the database.
 *   "new-nav": defineFeature(),
 *
 *   // A deterministic 20% of subjects.
 *   "new-checkout": defineFeature({
 *     describe: "Rebuilt checkout flow",
 *     rollout: 20,
 *   }),
 *
 *   // Targeting lives next to the declaration.
 *   "pricing-redesign": defineFeature({
 *     rollout: 50,
 *     when: (ctx) => {
 *       if (ctx.user?.email.endsWith("@acme.com")) return true;
 *       if (ctx.user?.plan === "free") return false;
 *       // abstain -> fall through to `rollout`
 *     },
 *   }),
 * };
 * ```
 *
 * The default export of `app/features/index.ts` is a plain object, and its keys
 * are the feature keys — no nesting, no prefix joining. That is deliberate: the
 * key you look up is the key that appears literally in the source, so answering
 * "is this feature still referenced?" — the one chore every feature eventually
 * needs — stays a grep.
 */
export function defineFeature(options: FeatureOptions = {}): Feature {
  return new Feature(options);
}

/** The shape of `app/features/index.ts`'s default export. */
export type FeatureRegistry = Record<string, Feature>;

/**
 * The `{ key: boolean }` map a registry describes, consumed through module
 * augmentation so `useFeature` and the `Features` facade are typed against the
 * application's own keys:
 *
 * ```ts
 * declare module "gemi/client" {
 *   export interface Features extends CreateFeatures<typeof AppFeatures> {}
 * }
 * ```
 *
 * Every feature is a boolean, so this is key extraction and nothing else — no
 * per-key value type to infer, and no tree to walk.
 */
export type CreateFeatures<T extends FeatureRegistry> = {
  [K in keyof T]: boolean;
};
