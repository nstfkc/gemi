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
 *       static $policies = [softDeletes<typeof User>()]
 *     }
 *
 * `typeof User` rather than `User`: the class carries `$schema`, which is what
 * constrains `field` to real columns (#262). The instance spelling still
 * compiles and simply checks nothing.
 *
 *     await User.findMany({})        // deleted rows are not there
 *     await User.expire({ where })   // sets deletedAt, does not remove the row
 *
 * **`User.delete()` is still a hard delete**, and cannot be made otherwise —
 * see the note on #263 above `softDelete` below. The policy scopes reads; it is
 * the wrapper that rewrites a write, and the wrapper cannot be named `delete`.
 *
 * Composing it with a policy of your own is now just a longer list, in the order
 * they should apply:
 *
 *     static $policies = [softDeletes<typeof User>(), new TenantPolicy()]
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

/**
 * The column names a model *class* declares, read off its generated `$schema`.
 *
 * This is the part of #262 that made it worth doing. The old constraint was
 * `keyof M & string` against an **instance** type, which is not a column check:
 * `softDeletes<User>({ field: "save" })` compiled clean and then raised
 * `UnknownFieldError` at runtime, because `save` is a method. Reading
 * `$schema.fields` instead asks the schema what the columns are, so the check
 * and the runtime error now disagree about nothing.
 *
 * It works because the generator emits `satisfies ModelSchema` rather than a
 * `: ModelSchema` annotation — see `bin/orm/emit.ts`. An annotation would widen
 * `fields` to `Record<string, FieldSchema>` and `keyof` it back to `string`.
 *
 * **Falls back to `string` rather than to `never`.** A caller can pass anything
 * that behaves like a model — the structural fakes in `soft-deletes.test.ts` do
 * — and those carry no literal schema. Degrading to unchecked keeps them
 * working; degrading to `never` would reject every `field` they pass.
 */
export type SchemaFields<M> = M extends { $schema: { fields: infer F } }
  ? Extract<keyof F, string> extends never
    ? string
    : Extract<keyof F, string>
  : string;

/**
 * The row a model class describes, so one type parameter can carry both.
 *
 * `softDeletes` hands its parameter to `ModelPolicy`, which uses it as the
 * **row** type — `redact` is called with a `Partial` of it. The schema, though,
 * hangs off the *class*. Taking the class and recovering the row through
 * `prototype` is what lets one spelling supply both, and it is the mechanism
 * #243 found and recorded rather than a new invention.
 *
 * An instance type has no `prototype`, so `softDeletes<User>()` still resolves
 * to `User` and keeps compiling — it simply gets no field checking, because an
 * instance type is not where the column names live.
 */
type RowOf<M> = M extends { prototype: infer Row } ? Row : M;

/**
 * **The parameter is still the model type, not the field union.**
 *
 * `SoftDeleteOptions` is exported, so an application can annotate with it —
 * `const opts: SoftDeleteOptions<User> = …`. Constraining the parameter to
 * `extends string` and taking the union directly read more honestly from inside
 * this file and broke every such annotation from outside it, with *"Type 'User'
 * does not satisfy the constraint 'string'"*. Keeping the model type and
 * resolving the union here costs nothing and keeps those compiling: a row type
 * has no `$schema`, so it degrades to `string` exactly as it did before, and
 * `SoftDeleteOptions<typeof User>` is the spelling that gains the check.
 */
export interface SoftDeleteOptions<M = any> {
  /**
   * The timestamp column. Defaults to `deletedAt`, which the template uses.
   *
   * Constrained to the model's **schema fields** when the model is reachable —
   * `softDeletes<typeof User>()`, `softDelete(User)`, `softDeleteMany(User)` —
   * so a typo, or a column the model does not have, is a compile error instead
   * of an `UnknownFieldError` on the first read.
   *
   * Passing no model leaves it `string`, and therefore unchecked. That is the
   * one spelling that cannot be constrained: there is nothing to constrain it
   * against.
   */
  field?: SchemaFields<M>;
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
): ModelPolicy<any, any, RowOf<M>> {
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
 *       static $policies = [softDeletes<typeof User>()]
 *       static expire = softDelete(User)
 *       static expireMany = softDeleteMany(User)
 *     }
 *
 * **The name is not `delete`, and cannot be** — the reason is below.
 * `User.delete()` stays a hard delete.
 *
 * Both return the row(s) the way the real operations do, and both are still
 * subject to the model's policies, because they go through `update` /
 * `updateMany` — which means the soft-delete scope applies and a
 * `expire({ where })` naming an already-deleted row finds nothing, exactly as
 * a hard delete of a missing row would.
 *
 * Why this does not return the generated `delete`'s own signature — #263.
 *
 * `static delete = softDelete(User)` is the recipe the docs used to teach, and
 * it does not type-check. The obvious repair is to have this return the model's
 * own `delete` type so the override is assignable to what it overrides. That
 * cannot work, and the reason is the language rather than the typing:
 *
 *     static delete = softDelete(User)
 *     //     ^ the type of this member would be read off `User`...
 *     //                       ^ ...whose `delete` is the member being defined
 *
 * TypeScript answers `TS7022: 'delete' implicitly has type 'any' because it
 * does not have a type annotation and is referenced directly or indirectly in
 * its own initializer.` Annotating it does not help either: the annotation has
 * to name `typeof UserModel.delete`, and `softDelete(User)` is then checked
 * against a generic signature it still cannot satisfy.
 *
 * Passing the *base* instead of the subclass would break the cycle and break
 * the feature: `softDelete` delegates to `model.update`, policies are resolved
 * per registered class, and `UserModel` carries none — so the soft-delete scope
 * would not apply and `delete` would hide rows it never filtered.
 *
 * So the recipe changed instead of the types, and `delete` stays a hard delete.
 * `docs/orm.md` says so in the words a reader needs, and
 * `soft-delete.test-d.ts` holds the documented snippet verbatim so it cannot
 * drift back.
 
 */
export function softDelete<T, M = any>(
  model: SoftDeletable<T, "update"> & M,
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
  model: SoftDeletable<T, "updateMany"> & M,
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
