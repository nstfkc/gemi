import { defineFeaturesConfig } from "gemi/services";
import AppFeatures from "@/app/features";

export default defineFeaturesConfig({
  /**
   * The flag declarations. This is the runtime half of the wiring — the type
   * half resolves `@/app/features` through the framework's own `gemi.d.ts` — so
   * both should point at the same class.
   */
  router: AppFeatures,

  /**
   * How long a loaded snapshot is reused, in seconds.
   *
   * This is the propagation delay: an edit to the `FeatureFlag` table is live on
   * every instance within this window, a kill switch included. There is no
   * cross-instance invalidation, so lower it if thirty seconds is too long to
   * wait during an incident — the cost is one query per instance per window.
   */
  ttl: 30,

  /**
   * Reusable condition sets a rule can name instead of repeating.
   *
   * In code rather than the database because "who counts as an enterprise
   * account" is business logic worth reviewing, and because a segment used by
   * ten flags should be edited once.
   */
  segments: {
    // internal: [{ attribute: "user.email", operator: "endsWith", value: "@example.com" }],
  },

  /**
   * Extra attributes every rule can target, as `attributes.*` or bare.
   *
   * Runs on every request inside the render path, so keep it cheap and free of
   * I/O. If it throws, evaluation degrades to no attributes rather than failing
   * the page.
   */
  // context: () => ({ plan: "pro" }),

  /**
   * Fires once per flag per request — where an experiment pipeline records
   * exposures. Errors are caught and logged.
   */
  // onEvaluate: (key, evaluation) => analytics.track("flag", { key, value: evaluation.value }),
});
