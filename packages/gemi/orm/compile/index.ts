import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import type { Operation, QueryPlan } from "../plan";
import type { ModelSchema } from "../schema";
import { compileRead, isReadOperation } from "./read";
import { compileWrite, isWriteOperation } from "./write";

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
  if (isReadOperation(op)) return compileRead(schema, op, args, dialect);
  if (isWriteOperation(op)) return compileWrite(schema, op, args, dialect);
  throw new UnsupportedQueryError(op, schema.name, op);
}

export { compileRead, isReadOperation };
export { compileWrite, isWriteOperation };
export {
  planNestedWrites,
  type ForeignKeyContribution,
  type NestedWritePlanning,
} from "./nested-writes";
export { assertUniqueWhere, matchUniqueKey, uniqueKeys } from "./unique";
export { compileWhere } from "./where";
export { compileOrderBy, parseOrderBy } from "./orderBy";
export { resolveSelection } from "./select";
export {
  MAX_RELATION_DEPTH,
  attachRelations,
  batchedStrategy,
  planRelations,
  type RelationPlan,
  type RelationPlanning,
  type RelationRequest,
  type RelationStrategy,
} from "./plan-relations";
export * from "./fragment";

export { lateralStrategy } from "./lateral";
