import { useContext } from "react";
import { RouteStateContext } from "./RouteStateContext";
import type { FeatureKey, FeatureValueOf } from "./rpc";

/**
 * Reads a feature flag evaluated by the server for this request.
 *
 * ```tsx
 * const enabled = useFeature("new-checkout");       // boolean
 *
 * switch (useFeature("pricing-page")) {             // "a" | "b" | "control"
 *   case "a": return <VariantA />;
 * }
 * ```
 *
 * Keys are typed against `app/features`, so a typo is a compile error rather
 * than a flag that silently reads as off.
 *
 * ## It never fetches
 *
 * The value comes from the payload the server already sent — embedded in the
 * document on first load, and replaced by each navigation's envelope after
 * that. So this is a context read: no request, no suspense, no loading state,
 * and no flash of the wrong variant, which is the failure mode that makes
 * client-evaluated flags unusable for anything above the fold.
 *
 * The corollary is that a flag flipped in the database reaches an open page on
 * its next navigation, not instantly.
 *
 * ## Reads route state, not server data
 *
 * `RouteStateContext` is what each navigation replaces — the same reason
 * `useLocale` reads it. Reading `ServerDataContext` instead would pin every flag
 * to the values from the initial document for the life of the session.
 */
export function useFeature<K extends FeatureKey>(key: K): FeatureValueOf<K> {
  // `= {}` because several existing tests provide a bare object as page data,
  // and an error-path envelope may carry no flags at all.
  const { features = {} } = useContext(RouteStateContext);

  if (process.env.NODE_ENV !== "production" && !(key in features)) {
    console.warn(
      `[gemi] Unknown feature flag "${String(key)}". Declare it in app/features, or check the key.`,
    );
  }

  // An unknown key resolves to `false` rather than throwing: a flag deleted
  // from the declarations, or a payload that predates one, must not white-screen
  // a page that renders it.
  return (features[key as string] ?? false) as FeatureValueOf<K>;
}

/**
 * Every flag the server sent, for a component that needs to branch on several
 * at once or forward them somewhere.
 */
export function useFeatures(): Record<string, boolean | string | number | null> {
  const { features = {} } = useContext(RouteStateContext);
  return features;
}
