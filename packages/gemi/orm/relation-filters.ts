/**
 * The *shape* of a relation filter — `where: { accounts: { some: … } }` — with
 * no opinion about SQL and none about policies.
 *
 * Two places need to agree about it and they must not import each other. The
 * where compiler turns a relation filter into a correlated subquery; the policy
 * walk has to reach the same nested `where`s and scope them, **before** the plan
 * key, for the same reason iteration 9 gave when a lateral join skipped the
 * child's `$exec`: a filter that reaches another model's rows is a read of that
 * model, and every read of a model is scoped.
 *
 * The leak this closes is quieter than a nested `include`, which is why it is
 * worth naming. `where: { memberships: { some: {} } }` returns no membership
 * rows at all — it returns *users*. An unscoped subquery therefore leaks
 * existence rather than data: which users have a membership in some tenant you
 * cannot see. That is still a cross-tenant read, and it is one nobody would
 * notice in a response body.
 *
 * `compile/` may not import `policy.ts` (invariant 2 — the compiler is a pure
 * function of the argument shape) and `policy.ts` may not import `compile/`
 * ("do not let policies see SQL"). So the shared vocabulary lives here, below
 * both, and carries neither.
 */

/** Prisma's operators, per relation kind. Sorted, because callers iterate them. */
export const MANY_FILTER_OPERATORS = ["every", "none", "some"] as const;
export const ONE_FILTER_OPERATORS = ["is", "isNot"] as const;

export function relationFilterOperators(
  kind: "one" | "many",
): readonly string[] {
  return kind === "many" ? MANY_FILTER_OPERATORS : ONE_FILTER_OPERATORS;
}

/**
 * Whether an object names operators, as opposed to being a to-one shorthand.
 *
 * `{ is: { name } }` is the operator form. `{ name }` is the shorthand, which
 * Prisma accepts on a to-one and rejects on a to-many. The distinction is
 * decided the same way in both callers because getting it wrong in one of them
 * means the compiler and the policy walk disagree about *where the nested where
 * is* — and a scope applied to the wrong node is a scope that does not apply.
 *
 * An empty object is not the operator form: `{}` on a to-one means "there is a
 * related row and it matches nothing in particular", which is the shorthand with
 * no members.
 */
export function isOperatorForm(
  value: object,
  operators: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => operators.includes(key));
}

/**
 * The key `_count` occupies inside an `include` or a `select`.
 *
 * Named here for the same reason the operators are: the compiler projects it and
 * the policy walk has to scope it, and if the two disagreed about the key one of
 * them would silently do nothing. It is also the one key in either container
 * that is neither a field nor a relation, so every walk over them needs to know
 * to skip it.
 */
export const COUNT_KEY = "_count";
