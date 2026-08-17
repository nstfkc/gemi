import { type AuthApiRouter } from "../auth/routes";
import type { CreateRPC } from "../http/ApiRouter";

export interface RPC extends CreateRPC<AuthApiRouter, "/auth"> {}

export interface ViewRPC {}

export interface I18nDictionary {}

/**
 * The application's features: `{ "feature-key": boolean }`.
 *
 * Augmented from the app's `app/features/index.ts` by the framework's own
 * `gemi.d.ts`, the same way `RPC` and `I18nDictionary` are — so an application
 * never edits a declaration file to get `useFeature("...")` typed.
 *
 * Every feature is a boolean, so mostly only the *keys* carry information. The
 * one exception is a `serverOnly: true` declaration, whose value type is a
 * marker rather than `boolean` — see `ClientFeatureKey`.
 *
 * Empty here, which is what makes an app with no `app/features` still compile:
 * `FeatureKey` below falls back to `string` when nothing has been declared.
 */
export interface Features {}

/**
 * The keys the `Features` facade accepts — every declared feature, server-only
 * ones included, since evaluating those on the server is what they are for.
 *
 * Falls back to `string` while `Features` is unaugmented. Without the fallback
 * `keyof Features` is `never`, and every call — including a correct one — would
 * fail to compile for an app that has not declared any features yet, or for one
 * whose `gemi.d.ts` did not resolve. Degrading to loose strings is the right
 * failure: it is the pre-feature status quo, not a broken build.
 */
export type FeatureKey = [keyof Features] extends [never] ? string : keyof Features;

/**
 * The subset of those keys `useFeature` accepts: the ones that actually reach
 * the browser.
 *
 * A `serverOnly: true` feature is deliberately withheld from the SSR payload, so
 * reading it on the client is `false` forever no matter what the database says —
 * a silent wrong answer, and the failure mode `serverOnly` exists to create.
 * Filtering it out here turns that into a compile error at the call site, which
 * is where somebody can still act on it.
 *
 * Same `string` fallback as above, for the same reason.
 */
export type ClientFeatureKey = [keyof Features] extends [never]
  ? string
  : {
      [K in keyof Features]-?: Features[K] extends boolean ? K : never;
    }[keyof Features];
