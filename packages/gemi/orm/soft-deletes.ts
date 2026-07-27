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
 *       static $policy = softDeletes()
 *     }
 *
 *     await User.findMany({})        // deleted rows are not there
 *     await User.delete({ where })   // sets deletedAt, does not remove the row
 *
 * Composing it with a policy of your own means composing the objects, since a
 * class has one `$policy`. The base-class route is usually cleaner:
 *
 *     class SoftDeleted extends UserModel { static $policy = softDeletes() }
 *     export class User extends SoftDeleted { static $policy = { ...mine } }
 *
 * ...which also gets the ordering right for free: `policiesFor` walks base to
 * derived, so the soft-delete scope is applied first and yours narrows further.
 */

export interface SoftDeleteOptions {
  /** The timestamp column. Defaults to `deletedAt`, which the template uses. */
  field?: string;
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
export function softDeletes(options: SoftDeleteOptions = {}): ModelPolicy {
  const field = options.field ?? "deletedAt";

  return {
    scope: () => ({ [field]: null }),

    // A soft-deleted model still creates ordinary rows; the column is left to
    // its own default (null). Present because a policy carrying `scope` with no
    // `onCreate` is refused — deliberately, since for a tenant scope that
    // combination is a half-written policy. Here the pass-through *is* the
    // correct behaviour, so it is stated rather than implied.
    onCreate: (_context, data) => data,
  };
}

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
 *       static $policy = softDeletes()
 *       static delete = softDelete(User)
 *       static deleteMany = softDeleteMany(User)
 *     }
 *
 * Both return the row(s) the way the real operations do, and both are still
 * subject to the model's policies, because they go through `update` /
 * `updateMany` — which means the soft-delete scope applies and a
 * `delete({ where })` naming an already-deleted row finds nothing, exactly as
 * a hard delete of a missing row would.
 */
export function softDelete<T>(
  model: { update(args: any): Promise<T> },
  options: SoftDeleteOptions = {},
): (args: any) => Promise<T> {
  const field = options.field ?? "deletedAt";

  return (args: any) => {
    assertNoData(args, "delete");
    return model.update({
      ...args,
      data: { [field]: new Date() },
    });
  };
}

export function softDeleteMany<T>(
  model: { updateMany(args: any): Promise<T> },
  options: SoftDeleteOptions = {},
): (args: any) => Promise<T> {
  const field = options.field ?? "deletedAt";

  return (args: any = {}) => {
    assertNoData(args, "deleteMany");
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
function assertNoData(args: any, operation: string): void {
  if (args?.data === undefined) return;

  throw new UnsupportedQueryError(
    "data",
    "soft delete",
    operation,
    `${operation} takes no 'data' — the soft-delete rewrite supplies it. ` +
      `Call update directly if you meant to change other fields at the same ` +
      `time.`,
  );
}
