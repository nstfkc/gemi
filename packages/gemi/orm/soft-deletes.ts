import { UnsupportedQueryError } from "./errors";
import type { ModelPolicy } from "./policy";

/**
 * Soft deletes, as a policy.
 *
 * This ships as a small built-in because it is the proof that the policy hook is
 * expressive enough to be worth having: hiding deleted rows from *every* read
 * including nested ones, and turning a `delete` into an `update`, is the thing
 * ORMs traditionally implement as a special case threaded through the query
 * builder. Here it is thirty lines against the same `ModelPolicy` interface an
 * application writes, with no privileged access to anything.
 *
 * Usage — `deletedAt` must be a nullable `DateTime` on the model:
 *
 *     export class User extends UserModel {
 *       static $policies = [softDeletes<User>()]
 *     }
 *
 *     await User.findMany({})        // deleted rows are not there
 *     await User.delete({ where })   // sets deletedAt, does not remove the row
 *
 * Composing it with a policy of your own is now just a longer list, in the order
 * they should apply:
 *
 *     static $policies = [softDeletes<User>(), new TenantPolicy()]
 *
 * That ordering is the author's, and within a class it is the array's. Across
 * classes `policiesFor` still walks base to derived, so a `$policies` on a
 * shared base is applied before a subclass's and can only be narrowed further.
 *
 * It stays a **factory** rather than a class because it takes configuration and
 * a model type parameter, and a bare constructor in a `$policies` array has
 * nowhere to put either. `PolicyEntry` accepts both forms for exactly this
 * reason.
 */

export interface SoftDeleteOptions<M> {
  /**
   * The timestamp column. Defaults to `deletedAt`, which the template uses.
   *
   * Constrained to `keyof M`, which is worth less than it looks and is stated
   * here precisely because this is what shows on hover:
   *
   * - Only `softDeletes<User>()` supplies `M`. `softDeletes()`, `softDelete()`
   *   and `softDeleteMany()` take the model as a *value*, `M` stays `any`, and
   *   `keyof any & string` is `string` — a typo compiles.
   * - Where it does bite it is `keyof` an *instance* type, so a method
   *   satisfies it: `field: "save"` type-checks. It catches typos, not
   *   non-columns.
   *
   * Either way a name that is not a column is `UnknownFieldError` on the first
   * read, naming the model and listing its columns — the compiler refuses
   * before a statement is built, so no dialect ever gets to say
   * `no such column`. Both halves are pinned:
   * `templates/saas-starter/app/models/soft-delete.test-d.ts` for what is
   * checked, `policies.test.ts` for what the unchecked path does.
   *
   * Narrowing this to the schema's field names is #262.
   */
  field?: keyof M & string;
}

/**
 * The read half: every query is scoped to rows whose delete timestamp is null.
 *
 * It applies to nested relation reads for the same reason every policy does —
 * a relation read is `$exec` on the related model — which is the half that
 * ORM-level soft deletes usually get wrong. A deleted `Account` does not appear
 * under `User.findMany({ include: { accounts: true } })` without anything being
 * written at the include site.
 */
export function softDeletes<M = any>(
  options: SoftDeleteOptions<M> = {},
): ModelPolicy<any, any, M> {
  const field = options.field ?? "deletedAt";

  return {
    scope: () => ({ [field]: null }),

    // A soft-deleted model still creates ordinary rows; the column is left to
    // its own default (null). Present because a policy carrying `scope` with no
    // `onCreate` is refused — deliberately, since for a tenant scope that
    // combination is a half-written policy. Here the pass-through *is* the
    // correct behaviour, so it is stated rather than implied.
    onCreate: (_context, data) => data,

    // The same statement for updates, and here it is doing real work rather than
    // satisfying a formality. This policy scopes on `deletedAt`, and
    // `softDelete()` below turns a delete into an update that *writes*
    // `deletedAt` — which is precisely the "an update moves a row out of the
    // scope that selected it" shape `ScopeEscapeError` refuses. It is also
    // exactly what soft deleting means, so this policy is the one that gets to
    // say the write is intended.
    //
    // Note it does not authorise anything else: the guard is per policy, so a
    // tenant policy sitting beside this one in `$policies` still has to answer
    // for its own column. That separation is the point of the per-policy check.
    onUpdate: (_context, data) => data,
  };
}

/**
 * What `softDelete` needs from the model it wraps: the write to delegate to,
 * and the schema to name in a refusal.
 *
 * Structural rather than `typeof Model`, so a caller can pass anything that
 * behaves like one — which is why `$schema` is optional here even though every
 * generated model has it.
 */
type SoftDeletable<T, Op extends string> = {
  [K in Op]: (args: any) => Promise<T>;
} & { $schema?: { name: string } };

/**
 * The write half: rewrites a `delete` into an `update` that sets the timestamp.
 *
 * Kept separate from `softDeletes()` and applied at the call site rather than
 * folded into the policy, because a policy rewrites *arguments* and this
 * changes the *operation* — and `$exec` dispatches on the operation before a
 * policy is consulted. Widening `ModelPolicy` to let a policy swap the
 * operation would make every `$exec` call's meaning depend on a hook, which is
 * a much larger claim than scoping a `where`.
 *
 *     export class User extends UserModel {
 *       static $policies = [softDeletes<User>()]
 *       static delete = softDelete(User)
 *       static deleteMany = softDeleteMany(User)
 *     }
 *
 * Caveat, and it is not this function's: against a *generated* model that class
 * does not type-check. The generated `delete` is generic in its arguments and
 * returns a result narrowed by them, and `(args: any) => Promise<T>` is not
 * assignable to it, so any `static delete =` is an illegal override regardless
 * of what it is assigned. The repo's own soft-delete tests give the static a
 * name of its own and so never hit it. Tracked as #263; the recipe is left as
 * written here because the fix may well be to make the override legal rather
 * than to rename it.
 *
 * Both return the row(s) the way the real operations do, and both are still
 * subject to the model's policies, because they go through `update` /
 * `updateMany` — which means the soft-delete scope applies and a
 * `delete({ where })` naming an already-deleted row finds nothing, exactly as
 * a hard delete of a missing row would.
 */
export function softDelete<T, M = any>(
  model: SoftDeletable<T, "update">,
  options: SoftDeleteOptions<M> = {},
): (args: any) => Promise<T> {
  const field = options.field ?? "deletedAt";

  return (args: any) => {
    assertNoData(model, args, "delete");
    return model.update({
      ...args,
      data: { [field]: new Date() },
    });
  };
}

export function softDeleteMany<T, M = any>(
  model: SoftDeletable<T, "updateMany">,
  options: SoftDeleteOptions<M> = {},
): (args: any) => Promise<T> {
  const field = options.field ?? "deletedAt";

  return (args: any = {}) => {
    assertNoData(model, args, "deleteMany");
    return model.updateMany({
      ...args,
      data: { [field]: new Date() },
    });
  };
}

/**
 * A `delete` takes no `data`, so one being present means the caller thinks they
 * are calling something else — most likely they wrote `update` and meant it.
 * Refused rather than silently overwritten by the timestamp.
 */
function assertNoData(
  model: { $schema?: { name: string } },
  args: any,
  operation: string,
): void {
  if (args?.data === undefined) return;

  throw new UnsupportedQueryError(
    "data",
    // The real model, not the literal `"soft delete"` this used to pass.
    // `UnsupportedQueryError` documents `model` as inspectable, and a string
    // that is not a model name can never be what an application matches on
    // (#112). `$schema` is optional only because the parameter is structural —
    // every generated model carries it.
    model.$schema?.name ?? "unknown",
    operation,
    `${operation} takes no 'data' — the soft-delete rewrite supplies it. ` +
      `Call update directly if you meant to change other fields at the same ` +
      `time.`,
  );
}
