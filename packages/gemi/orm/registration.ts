import {
  AmbiguousModelRegistrationError,
  UnregisteredPolicyClassError,
} from "./errors";
import { policiesFor } from "./policy";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

/** A model class, as much of one as anything below `Model.ts` can name. */
type ModelClass = object & { $schema: ModelSchema };

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
 *       static $policies = [{ scope: (ctx) => ({ orgId: ctx.user.orgId }) }]
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
 * `registerModels` runs this after registering, and `Kernel.models` runs
 * `registerModels` at boot, so an application that declares its model modules
 * gets it without asking. This is the same check for modules the Kernel does
 * not own — a test over a package's models, a script that boots nothing.
 *
 * It can only see modules it is handed, which is the residual either way: a
 * policied class in a file no barrel re-exports is invisible to it.
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

      // The two classes are on one prototype chain — a base and something
      // extending it — which is the arrangement almost every application has,
      // and the one this audit used to get wrong in both directions.
      //
      // `policiesFor` accumulates upwards, so a descendant's chain always
      // contains its ancestor's. What separates the two shapes is therefore
      // whether the **ancestor** carries anything of its own.
      if (descendsFrom(registered, model) || descendsFrom(model, registered)) {
        const ancestor = descendsFrom(model, registered) ? registered : model;
        const descendant = ancestor === registered ? model : registered;

        if (policiesFor(ancestor).length === 0) {
          // The ancestor contributes nothing, so the descendant is the first
          // class to carry a policy: it is not a view over the model, it *is*
          // the model. A generated base is the usual ancestor here, and a
          // hand-written intermediate behaves the same way.
          //
          // Registered already? Then this is the correct arrangement, and it
          // has to be skipped rather than reported — it used not to be, and
          // that is why the documented
          //
          //     assertPoliciesRegistered(generated, models)
          //
          // threw the moment an application wrote its first policy: it walked
          // the generated namespace, found `UserModel` diverging from the
          // registered `User`, and refused the thing it exists to protect.
          // Being reachable through a base is not the bug; querying through one
          // is, and that is a property of a call site rather than of a module's
          // export list, so `Model.$exec` keeps that direction.
          if (registered === descendant) continue;

          // Neither class carries anything, so which one owns the name changes
          // no query's scope. An unregistered plain subclass is not a mistake.
          if (!diverges) continue;

          // Not registered, and it has policies: #316 itself. The policied
          // class is not the one the name resolves to, so every nested read
          // runs the ancestor and skips it.
          throw new UnregisteredPolicyClassError(
            name,
            nameOf(registered),
            nameOf(model),
            ours.length > 0 ? "queried" : "registered",
          );
        }

        // The ancestor carries policies of its own, so it is a registered model
        // in good standing and the descendant is narrowing it. The registry
        // holds one class per name: registering the view applies its narrowing
        // to every nested read, and leaving the ancestor registered skips the
        // view's policies entirely. Both are silent, so neither is chosen.
        if (diverges) {
          throw new UnregisteredPolicyClassError(
            name,
            nameOf(ancestor),
            nameOf(descendant),
            "narrowing",
          );
        }

        // Same chain, same policies — a plain typed view. Nothing to report.
        continue;
      }

      if (!diverges) continue;

      // Unrelated classes claiming one name. Whichever is registered, the
      // other's policies are simply not in effect.
      throw new UnregisteredPolicyClassError(
        name,
        nameOf(registered),
        nameOf(model),
        ours.length > 0 ? "queried" : "registered",
      );
    }
  }
}

/**
 * Registers every model class the given modules export, under the name each
 * one's schema carries, and then audits the result.
 *
 * ### The line this exists to delete
 *
 * `register("User", User)` next to every subclass is a correct instruction and
 * a bad mechanism, because forgetting it is invisible. A relation read resolves
 * its target by name, so an unregistered policied subclass leaves the generated
 * base owning the name and every nested `include` of that model comes back
 * unscoped — no error, no warning, and an authorization hole in the direction
 * nobody checks. `assertPoliciesRegistered` turns that into a loud failure, but
 * only for someone who remembered to run it.
 *
 * Deriving the registration from the module removes the mistake instead of
 * reporting it. The name is not a string an author repeats; it is
 * `$schema.name`, which the generator wrote and the subclass inherits:
 *
 *     import * as generated from "./generated"
 *     import * as models from "./models"
 *
 *     registerModels(generated, models)
 *
 * Later modules win, so the application's classes replace the generated bases
 * they extend. `register` still exists and still works — this is what an
 * application calls once instead of writing it thirteen times.
 *
 * ### What it still cannot see
 *
 * Modules it is handed. A policied class in a file nothing imports is invisible
 * to this exactly as it is to `assertPoliciesRegistered`, and closing *that*
 * would take the framework enumerating the filesystem at boot. Handing it a
 * barrel is the whole discipline: one file to add a model to, and the audit
 * covers everything in it.
 *
 * `Kernel.models` is that call, wired at boot, so an application declares its
 * model modules the way it already declares config slices and providers.
 */
export function registerModels(
  ...modules: Array<Record<string, unknown>>
): void {
  // Elected into a local map first, and only committed once the audit passes.
  //
  // The registry is process-wide and outlives the throw. Registering as we went
  // meant a refused call left the arrangement it had just refused installed —
  // `registerModels({Ours}, {Theirs})` threw, and `"User"` resolved to `Theirs`
  // afterwards, which is the leaking mapping the audit exists to reject. A
  // server whose boot dies never notices; a dev server that catches and keeps
  // serving, or a test harness that continues past the error, serves the rest
  // of the process from it.
  const staged = new Map<string, ModelClass>();

  for (const module of modules) {
    const candidates = new Map<string, ModelClass[]>();

    // Deduped by identity first: `export { User }` alongside a default export
    // is the same class under two keys, not two classes competing for a name.
    for (const exported of new Set(Object.values(module))) {
      const model = asModelClass(exported);
      if (model === null) continue;

      const name = model.$schema.name;
      const existing = candidates.get(name);
      if (existing === undefined) candidates.set(name, [model]);
      else existing.push(model);
    }

    // Later modules win, which is what lets an application's classes replace
    // the generated bases they extend.
    for (const [name, classes] of candidates) {
      staged.set(name, elect(name, classes));
    }
  }

  // What the registry said before, so a failed audit can put it back. `register`
  // has no inverse, so a name that was previously *absent* cannot be made
  // absent again — it is left pointing at what this call elected. That is the
  // one residue, and it is the harmless direction: the alternative to a wrong
  // registration under a name nothing claimed is `ModelNotRegisteredError`, and
  // the class elected here is the one this module set would have used anyway.
  const previous = [...staged.keys()]
    .filter((name) => registry.has(name))
    .map((name) => [name, registry.get<unknown>(name)] as const);

  for (const [name, model] of staged) registry.register(name, model);

  try {
    assertPoliciesRegistered(...modules);
  } catch (error) {
    for (const [name, model] of previous) registry.register(name, model);
    throw error;
  }
}

/**
 * Which of several classes claiming one name in one module gets it.
 *
 * Two shapes put more than one candidate in a namespace, and they want opposite
 * answers, so neither "most derived" nor "least derived" is the rule on its
 * own:
 *
 *     export * from "./generated"      // UserModel, and
 *     export class User extends UserModel { static $policies = [...] }
 *
 * wants the subclass — electing the base here *is* the leak, in the one file an
 * author most plausibly writes it in. While
 *
 *     export class User extends UserModel { static $policies = [...] }
 *     export class AdminUser extends User {}
 *
 * wants `User`. `AdminUser` is a typed view over the same rows; it inherits the
 * policies either way, so registering it changes nothing when it adds none and
 * silently applies its own narrowing to every nested read when it does.
 *
 * What separates them is which class the *generator* wrote. It emits
 * `static $schema = schema.User` on the base, and a subclass inherits that
 * property rather than declaring one — so an own `$schema` is the mark of a
 * generated base, and it is a fact about the classes rather than about the
 * order somebody exported them in. Application classes are preferred over
 * bases; among application classes the least derived wins, for the reason
 * `AdminUser` gives.
 *
 * When that leaves no single answer the candidates are unrelated classes with a
 * genuine claim each, and there is nothing left to infer. That case is refused
 * rather than guessed at: `register` says which, in the application's own
 * words.
 */
function elect(name: string, classes: ModelClass[]): ModelClass {
  if (classes.length === 1) return classes[0]!;

  const written = classes.filter((candidate) => !isGeneratedBase(candidate));
  const eligible = written.length > 0 ? written : classes;

  if (eligible.length === 1) return eligible[0]!;

  const roots = eligible.filter((candidate) =>
    eligible.every(
      (other) => other === candidate || descendsFrom(other, candidate),
    ),
  );

  if (roots.length === 1) return roots[0]!;

  throw new AmbiguousModelRegistrationError(
    name,
    eligible.map((candidate) => nameOf(candidate)),
  );
}

/**
 * Whether the generator wrote this class, rather than an application extending
 * one it wrote.
 *
 * `$schema` is declared on the emitted base and inherited by everything below
 * it, so owning the property is the difference. Nothing has to be added to the
 * generated output for this to hold — it is already how `models.ts` is written,
 * and `Model.$exec` already reads `$schema` off the prototype chain for exactly
 * that reason. `registration.test.ts` in the template asserts the contract
 * against real generator output, because this is the one place a generator
 * change could quietly invalidate an assumption made here.
 *
 * **When it is wrong, it is wrong safely.** A subclass that redeclares
 * `static $schema` — pointing at a modified schema object, or by copy-paste —
 * reads as a base here. Every candidate then looks generated, `elect` falls
 * through to the whole set, and the least derived wins: the base takes the name
 * over the policied subclass. That is the arrangement #316 is about, so it does
 * not pass quietly — `assertPoliciesRegistered` runs immediately after and
 * refuses it, naming both classes. Loud and wrong beats silent and wrong, and
 * the reader's question at `Object.hasOwn` is exactly this one.
 */
function isGeneratedBase(candidate: ModelClass): boolean {
  return Object.hasOwn(candidate, "$schema");
}

/**
 * Whether `derived` has `base` in its static prototype chain — the `extends`
 * relation between two classes, walked on the constructor side because that is
 * where `$schema` and `$policies` live.
 */
function descendsFrom(derived: unknown, base: unknown): boolean {
  let current = Object.getPrototypeOf(derived);

  while (current !== null && current !== Function.prototype) {
    if (current === base) return true;
    current = Object.getPrototypeOf(current);
  }

  return false;
}

function nameOf(value: unknown): string {
  return (value as { name?: string })?.name ?? String(value);
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
function asModelClass(value: unknown): ModelClass | null {
  if (typeof value !== "function") return null;

  const schema = (value as { $schema?: ModelSchema }).$schema;
  if (schema === undefined || typeof schema.name !== "string") return null;

  return value as unknown as ModelClass;
}
