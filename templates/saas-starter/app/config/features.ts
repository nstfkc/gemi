import { defineFeaturesConfig } from "gemi/services";
import AppFeatures from "@/app/features";

export default defineFeaturesConfig({
  /**
   * The declarations. This is the runtime half of the wiring — the type half
   * resolves `@/app/features` through the framework's own `gemi.d.ts` — so both
   * should point at the same object.
   */
  features: AppFeatures,

  /**
   * How long a loaded snapshot is reused, in seconds.
   *
   * This is the propagation delay: switching a feature on or off in the
   * `FeatureFlag` table is live on every instance within this window, a kill
   * switch included. There is no cross-instance invalidation, so lower it if
   * thirty seconds is too long to wait during an incident — the cost is one
   * query per instance per window.
   */
  ttl: 30,

  /**
   * Extra attributes every `when` can read as `ctx.attributes`.
   *
   * Runs on every request inside the render path, so keep it cheap and free of
   * I/O. If it throws, evaluation degrades to no attributes rather than failing
   * the page.
   */
  // context: () => ({ plan: "pro" }),

  /**
   * Fires once per feature per request — where an experiment pipeline records
   * exposures. Errors are caught and logged.
   */
  // onEvaluate: (key, evaluation) => analytics.track("feature", { key, on: evaluation.value }),
});
