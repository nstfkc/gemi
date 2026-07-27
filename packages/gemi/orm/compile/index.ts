import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import type { Operation, QueryPlan } from "../plan";
import type { ModelSchema } from "../schema";
import { compileFindMany } from "./findMany";

/**
 * Argument tree -> SQL. Pure: a function of the argument *shape* and the
 * dialect, never of the values (invariant 2). That is what makes the whole
 * compiler unit-testable with no database attached, and it is why the plan
 * cache can key on shape alone.
 */
export function compile(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  switch (op) {
    case "findMany":
      return compileFindMany(schema, args, dialect);
    default:
      throw new UnsupportedQueryError(op, schema.name, op);
  }
}

export { compileFindMany };
export { compileWhere } from "./where";
export * from "./fragment";
