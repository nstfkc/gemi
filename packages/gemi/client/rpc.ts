import { type AuthApiRouter } from "../auth/routes";
import type { CreateRPC } from "../http/ApiRouter";

export interface RPC extends CreateRPC<AuthApiRouter, "/auth"> {}

export interface ViewRPC {}

export interface I18nDictionary {}

/**
 * The application's feature flags: `{ "flag-key": valueType }`.
 *
 * Augmented from the app's `app/features/index.ts` by the framework's own
 * `gemi.d.ts`, the same way `RPC` and `I18nDictionary` are — so an application
 * never edits a declaration file to get `useFeature("...")` typed.
 *
 * Empty here, which is what makes an app with no `app/features` still compile:
 * `FeatureKey` below falls back to `string` when nothing has been declared.
 */
export interface Features {}

/**
 * The keys `useFeature` and the `Features` facade accept.
 *
 * Falls back to `string` while `Features` is unaugmented. Without the fallback
 * `keyof Features` is `never`, and every call — including a correct one — would
 * fail to compile for an app that has not declared any flags yet, or for one
 * whose `gemi.d.ts` did not resolve. Degrading to loose strings is the right
 * failure: it is the pre-flag status quo, not a broken build.
 */
export type FeatureKey = [keyof Features] extends [never] ? string : keyof Features;

/** The value type declared for `K`, or the open `FlagValue` when untyped. */
export type FeatureValueOf<K> = K extends keyof Features
  ? Features[K]
  : boolean | string | number | null;
