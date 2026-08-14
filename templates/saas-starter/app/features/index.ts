import { FeatureRouter } from "gemi/http";

/**
 * Your application's feature flags.
 *
 * Each entry declares a flag's key, the type of value it resolves to, and the
 * value to use when the database says nothing about it. Whether a flag is on,
 * and who it is on *for*, is controlled from the `FeatureFlag` table — so
 * flipping a flag or changing its targeting does not need a deploy.
 *
 * Read them on the server with the `Features` facade and in a component with
 * `useFeature`, both typed against exactly the keys declared here.
 *
 * ```ts
 * import { Features } from "gemi/facades";
 * if (await Features.enabled("new-checkout")) { ... }
 * ```
 *
 * ```tsx
 * import { useFeature } from "gemi/client";
 * const variant = useFeature("pricing-page"); // "a" | "b" | "control"
 * ```
 *
 * **Do not annotate `features`.** Write `features = { ... }`, never
 * `features: FeatureDefinitions = { ... }` — the annotation widens the keys and
 * every flag silently becomes an untyped string.
 */
export default class extends FeatureRouter {
  features = {
    "new-checkout": this.boolean(false).describe("Rebuilt checkout flow"),
    "pricing-page": this.variant(["a", "b", "control"], "control"),
  };
}
