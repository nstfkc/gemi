import { useContext } from "react";
import { RouteStateContext } from "./RouteStateContext";
import type { ClientFeatureKey } from "./rpc";

/**
 * Reads a feature evaluated by the server for this request.
 *
 * ```tsx
 * if (useFeature("new-checkout")) {
 *   return <NewCheckout />;
 * }
 * ```
 *
 * Keys are typed against `app/features`, so a typo is a compile error rather
 * than a feature that silently reads as off. Features declared
 * `serverOnly: true` are excluded from that set: they are withheld from the
 * payload on purpose, so reading one here could only ever answer `false`. Use
 * the `Features` facade for those.
 *
 * ## It never fetches
 *
 * The value comes from the payload the server already sent — embedded in the
 * document on first load, and replaced by each navigation's envelope after
 * that. So this is a context read: no request, no suspense, no loading state,
 * and no flash of the wrong branch, which is the failure mode that makes
 * client-evaluated features unusable for anything above the fold.
 *
 * The corollary is that switching a feature on reaches an open page on its next
 * navigation, not instantly.
 *
 * ## Reads route state, not server data
 *
 * `RouteStateContext` is what each navigation replaces — the same reason
 * `useLocale` reads it. Reading `ServerDataContext` instead would pin every
 * feature to the values from the initial document for the life of the session.
 */
export function useFeature(key: ClientFeatureKey): boolean {
  // `= {}` because several existing tests provide a bare object as page data,
  // and an error-path envelope may carry no features at all.
  const { features = {} } = useContext(RouteStateContext);

  if (process.env.NODE_ENV !== "production" && !(key in features)) {
    // Both reasons, because the type system only rules out the second one for a
    // caller whose `gemi.d.ts` resolved — and "declare it" is actively wrong
    // advice for the app that already did, then marked it `serverOnly`.
    console.warn(
      `[gemi] Feature "${String(key)}" is not in the payload the server sent. Either it is not declared in app/features, or it is declared \`serverOnly: true\` and never reaches the browser.`,
    );
  }

  // An unknown key reads as off rather than throwing: a feature deleted from the
  // declarations, or a payload that predates one, must not white-screen a page
  // that renders it.
  return features[key as string] === true;
}

/**
 * Every feature the server sent, for a component that needs to branch on
 * several at once or forward them somewhere.
 */
export function useFeatures(): Record<string, boolean> {
  const { features = {} } = useContext(RouteStateContext);
  return features;
}
