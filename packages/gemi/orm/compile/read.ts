import type { SqlDialect } from "../dialect";
import { UnsupportedQueryError } from "../errors";
import type { Operation, QueryPlan } from "../plan";
import type { ModelSchema } from "../schema";
import { buildRowShaper } from "../shape";
import { type Binder, type Fragment, concat, joinFragments, render, sql } from "./fragment";
import { compileOrderBy, parseOrderBy, reverse, type OrderTerm } from "./orderBy";
import { resolveSelection } from "./select";
import { compileWhere } from "./where";

/** Every read operation, and what each accepts. */
const READ_ARGS: Record<string, Set<string>> = {
  findMany: new Set(["where", "orderBy", "skip", "take", "select", "include"]),
  findFirst: new Set(["where", "orderBy", "skip", "take", "select", "include"]),
  findFirstOrThrow: new Set([
    "where",
    "orderBy",
    "skip",
    "take",
    "select",
    "include",
  ]),
  findUnique: new Set(["where", "select", "include"]),
  findUniqueOrThrow: new Set(["where", "select", "include"]),
  // No `select`: Prisma's `count` uses it to return an object of per-field
  // counts, which is aggregate territory and is not emitted onto the generated
  // bases. Accepting it here and then ignoring it would return the plain total
  // under a shape the caller did not ask for.
  count: new Set(["where", "orderBy", "skip", "take"]),
};

export function isReadOperation(op: Operation): boolean {
  return op in READ_ARGS;
}

/** The single-row operations, which pin `take` to 1 regardless of the args. */
const SINGLE_ROW = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
]);

export function compileRead(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  assertArgs(schema, op, args);

  const context = { dialect, operation: op };
  const where = compileWhere(schema, args?.where, context, (a) => a?.where);

  if (op === "findUnique" || op === "findUniqueOrThrow") {
    assertUniqueWhere(schema, args?.where, op);
  }

  const from = sql(` from ${dialect.quoteIdent(schema.table)}`);
  const whereClause = where ? concat(sql(" where "), where) : sql("");

  // `count` needs no selection and no shaper, but `skip` / `take` still apply —
  // and they apply to the rows being counted, not to the single row the count
  // returns. Appending `limit` to the aggregate would cap the *result*, which
  // is always one row, and quietly report the unpaginated total. So when the
  // query paginates, the row query is wrapped in a subquery exactly the way
  // Prisma does it.
  if (op === "count") {
    const counted = sql(`select count(*) as ${dialect.quoteIdent("_count")}`);
    const paginated = args?.take !== undefined || args?.skip !== undefined;

    // Parsed unconditionally, even though an unpaginated count discards the
    // terms: validation must not depend on whether a *different* argument was
    // also supplied, or `orderBy: { nonexistent: "asc" }` is an error with a
    // `take` and silently fine without one.
    const parsed = parseOrderBy(schema, args?.orderBy, op);

    let statement: Fragment;
    if (!paginated) {
      statement = concat(counted, from, whereClause);
    } else {
      const { clause, terms } = pagination(schema, op, args, dialect, parsed);
      const order = compileOrderBy(terms, dialect);
      // One column, not `*`: the subquery exists to be counted, so the narrowest
      // thing that keeps a row identity is right.
      const key = schema.primaryKey[0] ?? Object.keys(schema.fields)[0];
      statement = concat(
        counted,
        sql(` from (select ${dialect.quoteIdent(schema.fields[key].column)}`),
        from,
        whereClause,
        order ? concat(sql(" order by "), order) : sql(""),
        clause,
        sql(`) as ${dialect.quoteIdent("sub")}`),
      );
    }

    const { text, binders } = render(statement, dialect);
    return {
      text,
      bind: binder(binders),
      shape(rows) {
        const row = (rows as Record<string, unknown>[])[0];
        return Number(row?._count ?? 0);
      },
    };
  }

  const fields = resolveSelection(schema, args, op);
  const columns = joinFragments(
    fields.map((field) => sql(dialect.quoteIdent(field.column))),
    ", ",
  );

  const {
    clause: paginationClause,
    terms,
    reversed,
  } = pagination(
    schema,
    op,
    args,
    dialect,
    parseOrderBy(schema, args?.orderBy, op),
  );
  const order = compileOrderBy(terms, dialect);

  const statement = concat(
    sql("select "),
    columns,
    from,
    whereClause,
    order ? concat(sql(" order by "), order) : sql(""),
    paginationClause,
  );

  const { text, binders } = render(statement, dialect);
  const shaper = buildRowShaper(fields, dialect);
  const single = SINGLE_ROW.has(op);

  return {
    text,
    bind: binder(binders),
    shape(rows) {
      const shaped = shaper(rows);
      // A negative `take` means "the last N". The ordering terms were flipped
      // so the database returns the right *rows*, but the caller asked for them
      // in the order their `orderBy` describes — so the page is flipped back
      // here. Verified against Prisma: `take: -3, orderBy: { id: "asc" }`
      // returns c, d, e, not e, d, c.
      if (reversed) shaped.reverse();
      // Prisma returns the row or `null`, not a one-element array. The
      // *OrThrow* variants turn that `null` into an error in `Model.$exec`,
      // where the model's name is in scope for the message.
      return single ? (shaped[0] ?? null) : shaped;
    },
  };
}

function binder(binders: Binder[]) {
  return (callArgs: any) => {
    const values: unknown[] = [];
    for (let i = 0; i < binders.length; i++) values.push(binders[i](callArgs));
    return values;
  };
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
 */
function pagination(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
  parsed: OrderTerm[],
): { clause: Fragment; terms: OrderTerm[]; reversed: boolean } {
  const single = SINGLE_ROW.has(op);
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

function assertArgs(schema: ModelSchema, op: Operation, args: any): void {
  if (args === undefined || args === null) return;

  if (typeof args !== "object" || Array.isArray(args)) {
    throw new UnsupportedQueryError(
      String(args),
      schema.name,
      op,
      "Expected an object.",
    );
  }

  // Checked before the per-key loop, so that passing both reports the thing
  // that is actually wrong rather than stopping at `include`.
  if (args.select !== undefined && args.include !== undefined) {
    throw new UnsupportedQueryError(
      "select + include",
      schema.name,
      op,
      "Prisma allows only one of them on the same query.",
    );
  }

  const allowed = READ_ARGS[op];
  for (const key of Object.keys(args).sort()) {
    if (args[key] === undefined) continue;
    if (!allowed.has(key)) {
      throw new UnsupportedQueryError(key, schema.name, op);
    }
    // `include` is in the accepted set so it reaches this specific message
    // rather than being reported as if it were a typo.
    if (key === "include") {
      throw new UnsupportedQueryError(
        "include",
        schema.name,
        op,
        "Relations are not implemented yet.",
      );
    }
  }
}

/**
 * `findUnique` must be given a key the database can prove is unique — the `@id`,
 * a single-field `@unique`, or a composite `@@unique` in Prisma's compound form
 * (`{ username_provider: { username, provider } }`).
 *
 * This runs once per argument shape, in the compiler, not per call. Anything
 * else would be a query that silently returns the *first* of several matches.
 */
function assertUniqueWhere(
  schema: ModelSchema,
  where: unknown,
  op: Operation,
): void {
  const candidates = uniqueKeys(schema);

  if (typeof where !== "object" || where === null) {
    throw unique(schema, op, candidates);
  }

  const keys = Object.keys(where as Record<string, unknown>).filter(
    (key) => (where as Record<string, unknown>)[key] !== undefined,
  );

  // Prisma's compound form: one key named after the fields joined by `_`.
  for (const candidate of candidates) {
    if (candidate.length === 1 && keys.includes(candidate[0])) return;
    if (candidate.length > 1 && keys.includes(candidate.join("_"))) return;
  }

  throw unique(schema, op, candidates);
}

function uniqueKeys(schema: ModelSchema): string[][] {
  const keys: string[][] = [];
  if (schema.primaryKey.length > 0) keys.push(schema.primaryKey);
  for (const group of schema.uniques) keys.push(group);
  return keys;
}

function unique(
  schema: ModelSchema,
  op: Operation,
  candidates: string[][],
): UnsupportedQueryError {
  const shown = candidates
    .map((group) => (group.length === 1 ? group[0] : `${group.join("_")}`))
    .join(", ");

  return new UnsupportedQueryError(
    "where",
    schema.name,
    op,
    `${op} needs a unique field. ${schema.name} declares: ${shown}. ` +
      `Use findFirst to query on anything else.`,
  );
}
