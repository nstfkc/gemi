import { UnregisteredPolicyClassError } from "./errors";
import { policiesFor } from "./policy";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

/**
 * Checks that every policied model class an application defines is the one the
 * registry resolves its name to — **ahead of any query**, rather than when one
 * happens to be run.
 *
 * ### Why this exists
 *
 * `Model.$exec` already refuses a query whose class carries policies the
 * registered class does not (`UnregisteredPolicyClassError`). That guard closed
 * the two shapes found in #51, and it is the right check, but it can only fire
 * on a class somebody actually queries **at the root**. Its condition begins
 * `registered !== this`, and there is a case where that is false and the leak is
 * real:
 *
 *     export class Membership extends MembershipModel {
 *       static $policy = { scope: (ctx) => ({ orgId: ctx.user.orgId }) }
 *     }
 *     // ...and no `register("Membership", Membership)`
 *
 * If nothing ever calls `Membership.findMany()` — because memberships are only
 * ever read through `include: { memberships: true }` — then the include resolves
 * the name to the *generated base*, `this` **is** that base, the comparison
 * never runs, and rows come back unscoped with no error. Not a policy chain that
 * fails to diverge: a check that is never reached.
 *
 * A model reached only through includes is usually a membership or a pivot,
 * which is exactly the kind that carries a tenant scope. So the residual runs
 * the wrong way: the guard is weakest where the data is most sensitive.
 *
 * ### What this does about it
 *
 * The same rule, triggered differently. Instead of waiting for a root query,
 * it takes the modules where an application's model classes live and applies the
 * divergence comparison to every one of them:
 *
 *     import * as models from "@/app/models"
 *     assertPoliciesRegistered(models)
 *
 * Reading a class out of a module namespace is what makes the unqueried case
 * visible — the class exists and is exported whether or not anything queries it.
 *
 * Call it at boot, or from a test. A test is enough to close the hole for CI and
 * costs nothing at runtime; booting with it turns a deploy of the mistake into a
 * failure to start rather than a quiet cross-tenant read. Neither is a
 * *substitute* for writing `register` next to the subclass, and this function
 * cannot become one: it can only see modules it is handed.
 */
export function assertPoliciesRegistered(
  ...modules: Array<Record<string, unknown>>
): void {
  for (const module of modules) {
    for (const exported of Object.values(module)) {
      const model = asModelClass(exported);
      if (model === null) continue;

      const name = model.$schema.name;
      const registered = registry.has(name)
        ? (registry.get<unknown>(name) as object)
        : undefined;

      // Nothing registered under the name at all. The generated `index.ts`
      // registers every model, so reaching this means it was never imported —
      // a different mistake, and one the first query reports clearly through
      // `ModelNotRegisteredError`. Not this function's business.
      if (registered === undefined || registered === model) continue;

      const ours = policiesFor(model);
      const theirs = policiesFor(registered);
      const diverges =
        ours.length !== theirs.length ||
        ours.some((policy, index) => policy !== theirs[index]);

      if (!diverges) continue;

      throw new UnregisteredPolicyClassError(
        name,
        (registered as { name?: string }).name ?? String(registered),
        (model as { name?: string }).name ?? String(model),
        ours.length > 0 ? "queried" : "registered",
      );
    }
  }
}

/**
 * A model class, structurally.
 *
 * Structural rather than `instanceof Model` on purpose: this module sits below
 * `Model.ts` in the import graph, and importing it here to answer a question
 * about shape would put a cycle between the registry, the policy hook and the
 * model base for no gain. `$schema` carrying a `name` is what every operation
 * already relies on.
 *
 * A module namespace holds anything the author exported — types erase, but
 * constants, helpers and re-exported values do not — so everything that is not
 * a model class is skipped rather than treated as an error.
 */
function asModelClass(
  value: unknown,
): (object & { $schema: ModelSchema }) | null {
  if (typeof value !== "function") return null;

  const schema = (value as { $schema?: ModelSchema }).$schema;
  if (schema === undefined || typeof schema.name !== "string") return null;

  return value as unknown as object & { $schema: ModelSchema };
}
