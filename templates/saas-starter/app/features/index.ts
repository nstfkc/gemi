import { defineFeature } from "gemi/services";

/**
 * Your application's features.
 *
 * Each key declares a feature, and the value declares who gets it — a
 * percentage rollout, a `when` predicate, or nothing at all for "everyone".
 * Whether the feature is switched on is the database's job, so shipping a
 * feature is a deploy and turning it on is not.
 *
 * Keys are flat and literal on purpose: `"billing/new-invoices"` appears in this
 * file exactly as you will look it up, so answering "is this still referenced?"
 * stays a grep.
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
 * if (useFeature("new-checkout")) { ... }
 * ```
 */
export default {
  /** On for everyone, once switched on in the database. */
  "new-checkout": defineFeature({
    describe: "Rebuilt checkout flow",
  }),

  /**
   * A deterministic half of subjects. The assignment is a pure function of the
   * subject, so it holds still across devices and processes without being
   * stored, and raising the number only ever adds people.
   */
  "pricing-redesign": defineFeature({
    describe: "New pricing page layout",
    rollout: 50,
    when: (ctx) => {
      // Staff always see it, regardless of the rollout. Returning nothing
      // abstains and lets the rollout decide.
      if (typeof ctx.user?.email === "string" && ctx.user.email.endsWith("@example.com")) {
        return true;
      }
    },
  }),

  /**
   * Never sent to the browser.
   *
   * Every client-visible key is embedded in the HTML of every page, so a key
   * named after something unannounced announces it. This one is still evaluated
   * on the server — `Features.enabled("project-nightingale")` works — but
   * `useFeature` will not accept the key, because the value there could only
   * ever be `false`.
   */
  "project-nightingale": defineFeature({
    describe: "Unannounced. The name is the secret.",
    serverOnly: true,
  }),
};
