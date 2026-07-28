import type { SqlDialect } from "../dialect";
import type { ModelSchema } from "../schema";
import type { Binder, Fragment } from "./fragment";
import { reverse, type OrderTerm } from "./orderBy";

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
 */
export function pagination(
  schema: ModelSchema,
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
