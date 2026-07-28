import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import type { Operation, QueryPlan } from "../plan";
import type { RelationStrategy } from "./plan-relations";
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
  /**
   * Which relation strategy plans this query's include tree, if not the default.
   *
   * Reads only. A write's relations are loaded from its `returning` rows, and
   * `insert … returning` cannot carry a lateral join — so `compileWrite` has
   * nothing to do with a strategy and is not given one.
   */
  strategy?: RelationStrategy,
): QueryPlan {
  if (isReadOperation(op)) {
    return compileRead(schema, op, args, dialect, strategy);
  }
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
