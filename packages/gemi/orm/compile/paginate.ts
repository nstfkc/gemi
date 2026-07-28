import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import type { ModelSchema } from "../schema";
import type { Binder, Fragment } from "./fragment";
import { reverse, type OrderTerm } from "./orderBy";

/**
 * `take` / `skip` have to be integers, and Prisma is stricter than "a number":
 * a `skip` counts rows to pass over, so a negative one is meaningless and is
 * rejected rather than clamped. A negative *`take`* is not — it means "the last
 * N".
 *
 * **Why refusing rather than coercing**, which is the cheaper fix and the wrong
 * one. The sign of a `take` decides the *SQL*: it flips every ordering term and
 * reverses the result set. Everything else about these two arguments is a bound
 * value. So a `take` that is a string does not merely arrive in the wrong type —
 * it takes the wrong branch, because the branch is `typeof take === "number" &&
 * take < 0` and a string is not a number:
 *
 *     { take: -2 }    ->  order flipped, bind 2   the last two rows
 *     { take: "-2" }  ->  order as written, bind 2   the *first* two rows
 *
 * `Math.abs(Number(...))` then binds `2` either way, so the statement is valid,
 * the result set is the right size, and the rows are wrong. No error anywhere.
 *
 * Coercing early would fix that one case — `Number("-2")` is negative — and
 * would keep accepting `take: "abc"`, which binds `NaN`. Prisma types these as
 * `number` and rejects a string outright, and #72 already chose refusal for the
 * same arguments on a *relation* node. This is that decision reaching the root,
 * where it should have been in the first place.
 *
 * **A fraction is the one deliberate divergence, and it is deliberate because
 * of what the alternative measures at.** Prisma accepts `take: 1.5` and
 * truncates toward zero. Binding it, which is what this did, does not:
 *
 *     prisma    take: 1.5   ->  1 row     truncates
 *     sqlite    limit ? = 1.5   ->  SQLiteError: datatype mismatch (SQLITE_MISMATCH)
 *     postgres  limit $1 = 1.5  ->  2 rows    rounds to nearest
 *
 * Measured through Bun against both engines. So the status quo is an opaque
 * driver error on one dialect and a silent disagreement with Prisma *and* with
 * the other dialect on the second — from one argument, with no line naming
 * `take`. Matching Prisma would mean truncating here and also changing #72's
 * relation-node rule, which refuses fractions today; refusing keeps one rule at
 * both levels and fails in the loud direction. `docs/orm.md` records it as a
 * divergence rather than leaving it to be discovered.
 *
 * `argument` is the name to report: `take` at the root, `accounts.take` on a
 * relation node.
 */
export function assertPageArgument(
  model: string,
  operation: string,
  argument: string,
  key: "take" | "skip",
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new UnsupportedQueryError(
      argument,
      model,
      operation,
      `Expected an integer, got ${JSON.stringify(value)}.`,
    );
  }
  if (key === "skip" && value < 0) {
    throw new UnsupportedQueryError(
      argument,
      model,
      operation,
      `A 'skip' counts rows to pass over, so it cannot be negative. Prisma ` +
        `rejects one too.`,
    );
  }
}

/**
 * `skip` / `take`, plus the two pieces of Prisma behaviour around them that are
 * invisible until you read the SQL it emits:
 *
 * - Paginating without an `orderBy` injects `order by <primary key> asc`.
 *   Without it, "page 2" is only meaningful if the storage engine happens to
 *   return a stable order, which is not guaranteed on either dialect.
 * - A *negative* `take` means "the last N": Prisma flips every ordering term,
 *   takes `abs(take)`, and then reverses the result set so the caller still
 *   sees their own ordering. `reversed` carries that last part out to `shape`.
 *
 * **Validation happens here rather than in each caller's argument check.** Three
 * operations page — `findMany` and friends, `count`, `aggregate` — and they
 * validate their arguments in two different files. Putting the check at the one
 * place that *reads* `take` and `skip` means a fourth pager cannot be added
 * without it, which is the same reason invariant 1 puts every query through one
 * door.
 */
export function pagination(
  schema: ModelSchema,
  /**
   * The operation being compiled, for the error message. Required rather than
   * defaulted: this exists to report which call was refused, and a default
   * would name the wrong one on every caller that forgot it.
   */
  operation: string,
  args: any,
  dialect: SqlDialect,
  parsed: OrderTerm[],
  /**
   * Whether the operation returns at most one row, which pins `take` to 1
   * whatever the arguments say. Passed rather than derived from the operation
   * name, so this module needs to know nothing about which operations exist —
   * which is also what keeps `read.ts` and `aggregate.ts` from importing each
   * other to share it.
   */
  single = false,
): { clause: Fragment; terms: OrderTerm[]; reversed: boolean } {
  // Against the caller's own arguments, before `single` pins anything. A
  // `findFirst` ignores the value of `take` — but it still accepts the
  // argument, and Prisma still rejects a string there, so refusing what was
  // written beats refusing what survived.
  if (args?.take !== undefined) {
    assertPageArgument(schema.name, operation, "take", "take", args.take);
  }
  if (args?.skip !== undefined) {
    assertPageArgument(schema.name, operation, "skip", "skip", args.skip);
  }

  const take = single ? 1 : args?.take;
  const skip = args?.skip;

  let terms = parsed;
  const paginating = take !== undefined || skip !== undefined;

  if (paginating && terms.length === 0 && !single) {
    terms = schema.primaryKey.map((name) => ({
      column: schema.fields[name]?.column ?? name,
      direction: "asc" as const,
    }));
  }

  const negative = typeof take === "number" && take < 0;
  if (negative) terms = reverse(terms);

  const takeBinder: Binder | null =
    take === undefined
      ? null
      : single
        ? () => 1
        : (callArgs: any) => Math.abs(Number(callArgs?.take));

  const skipBinder: Binder | null =
    skip === undefined ? null : (callArgs: any) => Number(callArgs?.skip);

  return {
    clause: dialect.paginate(takeBinder, skipBinder),
    terms,
    reversed: negative,
  };
}
