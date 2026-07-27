import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import type { QueryPlan } from "../plan";
import type { ModelSchema } from "../schema";
import { buildRowShaper } from "../shape";
import { concat, joinFragments, render, sql } from "./fragment";
import { compileWhere } from "./where";

/**
 * Every argument key iteration 1 understands. Anything else throws — see the
 * note on `UnsupportedQueryError`: a silently ignored `take` is the worst
 * failure this ORM could have.
 */
const SUPPORTED_ARGS = new Set(["where"]);

export function compileFindMany(
  schema: ModelSchema,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  if (args !== undefined && args !== null) {
    // Without this, `findMany("x" as any)` walks the string's indices and
    // reports `does not support '0'`. The types make it unlikely; the error is
    // just misleading if it happens anyway.
    if (typeof args !== "object" || Array.isArray(args)) {
      throw new UnsupportedQueryError(
        String(args),
        schema.name,
        "findMany",
        "Expected an object.",
      );
    }

    for (const key of Object.keys(args).sort()) {
      if (args[key] === undefined) continue;
      if (!SUPPORTED_ARGS.has(key)) {
        throw new UnsupportedQueryError(key, schema.name, "findMany");
      }
    }
  }

  // Prisma's default is every scalar field, but never as `select *`: the
  // explicit list is what lets the shaper be built once from a fixed column
  // order, and what stops a migration from silently changing the result shape.
  const fields = Object.values(schema.fields);
  const columns = joinFragments(
    fields.map((field) => sql(dialect.quoteIdent(field.column))),
    ", ",
  );

  const where = compileWhere(schema, args?.where, dialect, "findMany");

  const statement = concat(
    sql("select "),
    columns,
    sql(` from ${dialect.quoteIdent(schema.table)}`),
    where ? concat(sql(" where "), where) : sql(""),
  );

  const { text, binders } = render(statement, dialect);
  const shaper = buildRowShaper(fields, dialect);

  return {
    text,
    bind(callArgs: any) {
      const values: unknown[] = [];
      for (let i = 0; i < binders.length; i++) values.push(binders[i](callArgs));
      return values;
    },
    shape(rows: unknown[]) {
      return shaper(rows);
    },
  };
}
