import { clientSideValue, hasClientSideValue } from "../defaults";
import type { SqlDialect } from "../dialect";
import {
  MissingRequiredValueError,
  ParameterLimitError,
  ReturningUnsupportedError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import type { Operation, QueryPlan } from "../plan";
import type { FieldSchema, ModelSchema } from "../schema";
import { buildRowShaper } from "../shape";
import {
  type Binder,
  type Fragment,
  bindValues,
  concat,
  joinFragments,
  param,
  render,
  sql,
} from "./fragment";
import {
  type ForeignKeyContribution,
  type NestedWritePlanning,
  planNestedWrites,
} from "./nested-writes";
import { planRelations } from "./plan-relations";
import { resolveSelection, withKeyFields } from "./select";
import { matchUniqueKey } from "./unique";
import { compileWhere } from "./where";

/**
 * The write surface: `create`, `createMany`, `update`, `updateMany`, `delete`,
 * `deleteMany`, `upsert`.
 *
 * Everything here obeys the same two rules the read compiler does, and for the
 * same reasons (invariant 2): the SQL text is a pure function of the argument
 * *shape*, and every value is a bound parameter. A `create` with the same field
 * set is one plan whatever the values are.
 *
 * Two decisions worth finding here rather than inferring from the code:
 *
 * **1. Row counts come from `RETURNING`, not from driver metadata.**
 * `updateMany` and `deleteMany` return `{ count }`, and the obvious source is
 * whatever the driver reports about the statement. Measured, that source is not
 * portable: Bun's SQLite driver leaves `affectedRows` **null** on every
 * statement and puts the number on a `count` property instead, and neither is
 * documented or verifiable against Postgres from here. So the count is the
 * number of rows a `RETURNING <primary key>` gives back — one statement shape on
 * every dialect, exact by construction, and dependent on nothing undocumented.
 * It costs one key column per affected row on the wire, which is a real cost on
 * a very large `deleteMany`; iteration 7 owns performance and can revisit it
 * with a benchmark rather than a guess.
 *
 * **2. `createMany` fills defaults explicitly rather than grouping rows.**
 * Prisma allows rows with different key sets in one call, and a single multi-row
 * `INSERT` cannot express that directly — every row must supply every column.
 * The column list is therefore the union of every row's keys, and a row missing
 * one gets its client-side default, or `NULL` if the column is nullable. The one
 * case that cannot be filled is a column with a *database* default that some
 * rows supply and others do not: `NULL` would override the default rather than
 * request it, and the `DEFAULT` keyword is not available — SQLite rejects it
 * inside a `VALUES` list (verified: `near "DEFAULT": syntax error`). That case
 * is refused with an error naming the column, rather than silently written wrong.
 */

const WRITE_ARGS: Record<string, Set<string>> = {
  create: new Set(["data", "select", "include"]),
  createMany: new Set(["data"]),
  update: new Set(["data", "where", "select", "include"]),
  updateMany: new Set(["data", "where"]),
  delete: new Set(["where", "select", "include"]),
  deleteMany: new Set(["where"]),
  upsert: new Set(["where", "create", "update", "select", "include"]),
};

/** The writes that return one row, and raise when they match none. */
const SINGLE_ROW = new Set(["create", "update", "delete", "upsert"]);

/** The writes that return `{ count }` rather than rows. */
const COUNTING = new Set(["createMany", "updateMany", "deleteMany"]);

export function isWriteOperation(op: Operation): boolean {
  return op in WRITE_ARGS;
}

export function compileWrite(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  assertArgs(schema, op, args);

  // Every write reports its result — the row, or the number of rows — through
  // `RETURNING`. Asked rather than assumed so MySQL is a named gap.
  if (!dialect.supportsReturning) {
    throw new ReturningUnsupportedError(schema.name, op, dialect.name);
  }

  switch (op) {
    case "create":
      return compileCreate(schema, op, args, dialect);
    case "createMany":
      return compileCreateMany(schema, op, args, dialect);
    case "update":
    case "updateMany":
      return compileUpdate(schema, op, args, dialect);
    case "delete":
    case "deleteMany":
      return compileDelete(schema, op, args, dialect);
    case "upsert":
      return compileUpsert(schema, op, args, dialect);
    default:
      throw new UnsupportedQueryError(op, schema.name, op);
  }
}

// --- create ----------------------------------------------------------------

function compileCreate(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  const nested = planNestedWrites(
    schema,
    args?.data,
    op,
    (callArgs) => callArgs?.data,
  );

  const columns = insertColumns(
    schema,
    args?.data,
    nested.contributions,
    op,
    dialect,
    (callArgs) => callArgs?.data,
  );

  const returning = returningClause(schema, args, dialect, op, nested);

  const statement = concat(
    sql(`insert into ${dialect.quoteIdent(schema.table)}`),
    valuesClause([columns], dialect),
    returning.clause,
  );

  return plan(statement, dialect, op, returning, nested);
}

// --- createMany ------------------------------------------------------------

function compileCreateMany(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  const rows = args?.data === undefined ? [] : listOf(args.data);

  // Prisma returns `{ count: 0 }` for an empty list without touching the
  // database, but a plan must have a statement. A constant-false select is the
  // cheapest thing that yields zero rows on both dialects, and it keeps the
  // empty case on exactly the same code path as every other — no branch in the
  // choke point, no plan that is a plan in name only.
  if (rows.length === 0) {
    const key = keyColumn(schema, dialect);
    const { text, binders } = render(
      sql(
        `select ${key} from ${dialect.quoteIdent(schema.table)} where false`,
      ),
      dialect,
    );
    return {
      text,
      bind: bindValues(binders),
      shape: (returned) => ({ count: returned.length }),
    };
  }

  const grid = createManyColumns(schema, rows, op, dialect);

  // `insert ... default values` inserts exactly one row and has no multi-row
  // spelling: `values (DEFAULT), (DEFAULT)` is rejected by SQLite, and the
  // zero-column list leaves nothing else to repeat. So a grid with no columns
  // and more than one row would quietly insert one — a wrong row count *and* a
  // wrong `{ count }`, from a statement that succeeds.
  //
  // Only reachable on a model where every field is autoincrement, database
  // default or nullable *and* no row supplies any of them, so the template's
  // schema cannot produce it. Refused by name anyway, because a silent wrong
  // count is the failure class this file is arranged to prevent.
  if (grid[0].length === 0 && rows.length > 1) {
    throw new UnsupportedQueryError(
      "data",
      schema.name,
      op,
      `All ${rows.length} rows are empty and ${schema.name} has no ` +
        `client-side default to fill, so there is no column to insert. A ` +
        `multi-row insert of nothing but database defaults cannot be ` +
        `expressed on both dialects. Call create ${rows.length} times, or ` +
        `set at least one field per row.`,
    );
  }

  assertParameterCount(schema, op, rows.length * grid[0].length, dialect);

  const returning = returningClause(schema, undefined, dialect, op, undefined);

  const statement = concat(
    sql(`insert into ${dialect.quoteIdent(schema.table)}`),
    valuesClause(grid, dialect),
    returning.clause,
  );

  const { text, binders } = render(statement, dialect);
  return {
    text,
    bind: bindValues(binders),
    shape: (returned) => ({ count: returned.length }),
  };
}

/**
 * The column grid for a multi-row insert: one `WriteColumn[]` per row, every
 * row carrying the same fields in the same order.
 *
 * The order is the *schema's*, never the first row's key order. That is not a
 * tidiness point: with the column list taken from row one and the values taken
 * per row by key order, a second row whose keys were written in a different
 * order binds its values into the wrong columns. Same types, no error, wrong
 * data — the worst shape of bug this file could have. Every value is looked up
 * by field name, and there is a test for exactly this.
 */
function createManyColumns(
  schema: ModelSchema,
  rows: unknown[],
  op: Operation,
  dialect: SqlDialect,
): WriteColumn[][] {
  const supplied = rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new UnsupportedQueryError(
        `data[${index}]`,
        schema.name,
        op,
        "Expected an object.",
      );
    }

    const keys = new Set<string>();
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (key in schema.relations) {
        // Prisma's `createMany` takes unchecked input — scalars and foreign
        // keys only. A nested write there has no defined ordering across rows.
        throw new UnsupportedQueryError(
          `data.${key}`,
          schema.name,
          op,
          "createMany cannot contain nested writes. Use create per row.",
        );
      }
      if (!(key in schema.fields)) {
        throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
      }
      keys.add(key);
    }
    return keys;
  });

  // The union, walked in schema order so the emitted column list depends only
  // on *which* fields appear, never on how any row was written.
  const union: FieldSchema[] = [];
  for (const field of Object.values(schema.fields)) {
    const inSome = supplied.some((keys) => keys.has(field.name));
    if (inSome || hasClientSideValue(field)) union.push(field);
  }

  for (const field of union) {
    const missing = supplied.some((keys) => !keys.has(field.name));
    if (!missing) continue;

    if (hasClientSideValue(field)) continue;
    if (field.nullable) continue;

    // A database-side default that only some rows override. `NULL` would
    // *overwrite* the default rather than request it, and SQLite has no
    // `DEFAULT` keyword inside a `VALUES` list to ask for it with.
    if (field.default) {
      throw new UnsupportedQueryError(
        `data.${field.name}`,
        schema.name,
        op,
        `Some rows set '${field.name}' and others leave it to the database ` +
          `default. A single multi-row insert cannot express both. Split the ` +
          `call, or set '${field.name}' on every row.`,
      );
    }

    const index = supplied.findIndex((keys) => !keys.has(field.name));
    throw new MissingRequiredValueError(
      schema.name,
      `${op}.data[${index}]`,
      field.name,
    );
  }

  return rows.map((_row, index) =>
    union.map((field) => ({
      field,
      value: supplied[index].has(field.name)
        ? valueBinder(field, dialect, (callArgs) =>
            listOf(callArgs?.data)[index]?.[field.name],
          )
        : defaultBinder(field, dialect),
    })),
  );
}

// --- update / updateMany ---------------------------------------------------

function compileUpdate(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  const many = op === "updateMany";

  if (!many) matchUniqueKey(schema, args?.where, op);

  // Prisma's `updateMany` takes unchecked input — scalars and foreign keys, no
  // relation keys — and rejects one with `Unknown argument 'organization'`.
  // Refused by name here for the same reason `createMany` refuses it: without
  // this the key is neither executed nor reported, since `planNestedWrites`
  // never runs and `suppliedFields` skips relation keys silently. A `data` of
  // only a relation key would then reach "At least one field must be updated",
  // which names the wrong problem.
  if (many) {
    assertNoNestedWrites(
      schema,
      args?.data,
      op,
      "data",
      "updateMany cannot contain nested writes — it has no single row to " +
        "attach them to. Use update per row.",
    );
  }

  const nested = many
    ? undefined
    : planNestedWrites(schema, args?.data, op, (callArgs) => callArgs?.data);

  const assignments = updateAssignments(
    schema,
    args?.data,
    nested?.contributions ?? [],
    op,
    dialect,
  );

  if (assignments.length === 0) {
    throw new UnsupportedQueryError(
      "data",
      schema.name,
      op,
      "At least one field must be updated.",
    );
  }

  const where = compileWhere(
    schema,
    args?.where,
    { dialect, operation: op },
    (callArgs) => callArgs?.where,
  );

  const returning = returningClause(schema, args, dialect, op, nested);

  const statement = concat(
    sql(`update ${dialect.quoteIdent(schema.table)} set `),
    joinFragments(assignments, ", "),
    where ? concat(sql(" where "), where) : sql(""),
    returning.clause,
  );

  return plan(statement, dialect, op, returning, nested);
}

// --- delete / deleteMany ---------------------------------------------------

/**
 * KNOWN DIVERGENCE — `delete` with an `include` on a cascading relation.
 *
 * The relation reads run *after* the delete statement, from `$exec`. Where the
 * schema declares `onDelete: Cascade`, the database has already removed the
 * children by then, so the `include` comes back empty; Prisma runs the whole
 * thing in a transaction and returns the children as they were.
 *
 * Not fixable at this layer. The fix is to read the relations before the delete
 * inside one transaction, which is iteration 5's to provide — and once it does,
 * this is the case to write the test for. Recorded here rather than left to be
 * discovered because the template's schema declares no cascades, so the
 * differential harness cannot see it: the first cascading model added to any
 * application would.
 */
function compileDelete(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  if (op === "delete") matchUniqueKey(schema, args?.where, op);

  const where = compileWhere(
    schema,
    args?.where,
    { dialect, operation: op },
    (callArgs) => callArgs?.where,
  );

  const returning = returningClause(schema, args, dialect, op, undefined);

  const statement = concat(
    sql(`delete from ${dialect.quoteIdent(schema.table)}`),
    where ? concat(sql(" where "), where) : sql(""),
    returning.clause,
  );

  return plan(statement, dialect, op, returning, undefined);
}

// --- upsert ----------------------------------------------------------------

/**
 * `insert ... on conflict (<key>) do update set ...`, which both dialects
 * support and which does in one statement what Prisma's `upsert` describes.
 *
 * The alternative — read, then branch to a create or an update — is two
 * statements with a race between them: two concurrent upserts of the same key
 * both see "absent" and both insert, and one gets a unique violation. Since
 * there is no transaction until iteration 5, the single-statement form is not
 * just faster here, it is the only correct one.
 *
 * The conflict target comes from the `where`'s unique key, so it is a schema
 * identifier like every other. Nested writes are refused inside an upsert:
 * they would have to run before an insert that may turn out to be an update,
 * and there is nothing sensible to do with the row they created if it does.
 */
function compileUpsert(
  schema: ModelSchema,
  op: Operation,
  args: any,
  dialect: SqlDialect,
): QueryPlan {
  const key = matchUniqueKey(schema, args?.where, op);

  // Since Prisma 5 a `WhereUniqueInput` may carry extra non-unique filters
  // beside the key, and they narrow the match further. `update` and `delete`
  // honour that for free: their whole `where` goes through `compileWhere`.
  //
  // An upsert cannot. Its `where` becomes an `on conflict (...)` target, which
  // is a *key*, not a predicate — there is nowhere to put `deletedAt: null`.
  // Compiling only the key part would mean `where: { publicId, deletedAt: null }`
  // updating a soft-deleted row that Prisma would have left alone (Prisma would
  // find no match, attempt the create, and hit a unique violation). Refused
  // rather than narrowed, for the same reason the create-omits-the-key shape a
  // few lines down is.
  const named = key.length > 1 ? key.join("_") : key[0];
  const extra = Object.keys(args.where as Record<string, unknown>).filter(
    (name) => name !== named && args.where[name] !== undefined,
  );
  if (extra.length > 0) {
    throw new UnsupportedQueryError(
      "where",
      schema.name,
      op,
      `The where clause carries ${extra.join(", ")} beside the unique key ` +
        `'${named}'. An upsert compiles its where into an 'on conflict' ` +
        `target, which can only be a key, so the extra ${
          extra.length === 1 ? "filter would be" : "filters would be"
        } silently dropped. Drop ${extra.length === 1 ? "it" : "them"} here, ` +
        `or use findFirst plus update / create.`,
    );
  }

  for (const branch of ["create", "update"] as const) {
    assertNoNestedWrites(
      schema,
      args?.[branch],
      op,
      branch,
      "Nested writes inside an upsert are not implemented: they would have " +
        "to run before it is known whether the row is being inserted or " +
        "updated.",
    );
  }

  // `on conflict` only fires if the row being inserted actually collides on the
  // target. `upsert({ where: { id: 1 }, create: { email } })` never can — the
  // `create` supplies no `id`, so the insert mints a fresh one and the update
  // branch is unreachable. Prisma means something different by that call: find
  // by `where`, then update or create. Expressing *that* takes a read and a
  // write with no transaction between them, which is iteration 5's to give.
  //
  // So the case is refused rather than silently turned into an insert. This is
  // narrow: the ordinary shape — `where: { email }, create: { email, ... }` —
  // supplies the key and works.
  const createFields = suppliedFields(schema, args?.create);
  const absent = key.filter((name) => !createFields.has(name));
  if (absent.length > 0) {
    throw new UnsupportedQueryError(
      "upsert",
      schema.name,
      op,
      `The where clause selects on ${key.join(", ")}, but 'create' does not ` +
        `set ${absent.join(", ")}. The insert could never conflict on that ` +
        `key, so the update branch would be unreachable and the row would ` +
        `always be created. Set ${absent.join(", ")} in 'create' too, or use ` +
        `update and create separately.`,
    );
  }

  const columns = withConflictKeyCheck(
    insertColumns(
      schema,
      args?.create,
      [],
      op,
      dialect,
      (callArgs) => callArgs?.create,
    ),
    schema,
    key,
    op,
    dialect,
  );

  // Inside the conflict clause every column read on the right of an `=` has to
  // name its table, or Postgres cannot tell the existing row from `excluded`.
  const qualifier = `${dialect.quoteIdent(schema.table)}.`;

  const assignments = updateAssignments(
    schema,
    args?.update,
    [],
    op,
    dialect,
    (callArgs) => callArgs?.update,
    qualifier,
  );

  const target = joinFragments(
    key.map((name) => sql(dialect.quoteIdent(fieldOf(schema, name).column))),
    ", ",
  );

  // `update: {}` is legal in Prisma and means "leave the existing row alone,
  // but return it". `do nothing` would return no row at all, so the row is
  // assigned to itself: an unqualified column on the right of a `do update set`
  // reads the *existing* row on both dialects.
  const effective =
    assignments.length > 0
      ? assignments
      : [
          sql(
            `${dialect.quoteIdent(fieldOf(schema, key[0]).column)} = ` +
              `${qualifier}${dialect.quoteIdent(fieldOf(schema, key[0]).column)}`,
          ),
        ];

  const returning = returningClause(schema, args, dialect, op, undefined);

  const statement = concat(
    sql(`insert into ${dialect.quoteIdent(schema.table)}`),
    valuesClause([columns], dialect),
    sql(" on conflict ("),
    target,
    sql(") do update set "),
    joinFragments(effective, ", "),
    returning.clause,
  );

  return plan(statement, dialect, op, returning, undefined);
}

/**
 * The other half of making `on conflict` mean what Prisma's `upsert` means.
 *
 * Compilation can prove the conflict key is *present* in `create`, but not that
 * it holds the same value as `where` — values do not exist at compile time, and
 * putting them there would break the plan cache. So the check happens at bind
 * time, where values are exactly what is in scope.
 *
 * Without it, `upsert({ where: { email: "a" }, create: { email: "b" }, ... })`
 * inserts "b" and conflicts — or does not — on "b", while Prisma looks for "a".
 * That is a silent divergence on a write, which is the failure this whole file
 * is arranged to prevent. Loud is better.
 */
function withConflictKeyCheck(
  columns: WriteColumn[],
  schema: ModelSchema,
  key: string[],
  op: Operation,
  dialect: SqlDialect,
): WriteColumn[] {
  const keyed = new Set(key);

  return columns.map((column) => {
    if (!keyed.has(column.field.name)) return column;

    const locate = whereValue(key, column.field.name);

    return {
      field: column.field,
      value: (args, context) => {
        const inserted = column.value(args, context);
        const selected = dialect.encode(locate(args), column.field);

        if (!sameEncoded(inserted, selected)) {
          throw new UnsupportedQueryError(
            "upsert",
            schema.name,
            op,
            `'${column.field.name}' is ${describe(selected)} in ` +
              `the where clause but ${describe(inserted)} in ` +
              `'create'. An upsert looks the row up by the where clause and ` +
              `inserts what 'create' says, so the two must agree on the key.`,
          );
        }

        return inserted;
      },
    };
  });
}

/**
 * Do two *encoded* values stand for the same thing?
 *
 * Not `===`, because `encode` is a per-dialect pass-through for whatever the
 * driver binds natively, and what a driver binds natively is not always a
 * primitive. Postgres passes a `DateTime` through as the `Date` it was given,
 * and both dialects pass `Bytes` through as a `Uint8Array` — so the same
 * instant and the same bytes arrive here as two distinct objects, and identity
 * refuses a correct upsert with a message printing two equal-looking strings.
 *
 * That is exactly the SQLite/Postgres asymmetry this codebase keeps finding:
 * SQLite encodes `DateTime` to a number and never noticed.
 *
 * Everything else falls through to `!==`, which is right for the string,
 * number, boolean and bigint an encoder can produce. `NaN` is not reachable —
 * it cannot be a unique key value that also round-trips through a `where`.
 */
function sameEncoded(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  return false;
}

/** A value for an error message, without pretending a `Date` is a string. */
function describe(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (ArrayBuffer.isView(value)) return `${value.byteLength} bytes`;
  return JSON.stringify(String(value));
}

/**
 * Reads one key field out of a `where`, in either of the two forms Prisma
 * accepts: named directly, or inside the compound object a composite
 * `@@unique` is addressed through (`{ username_provider: { username, ... } }`).
 */
function whereValue(key: string[], field: string): (args: any) => unknown {
  const compound = key.length > 1 ? key.join("_") : undefined;
  return (args) => {
    const where = args?.where;
    if (where === undefined || where === null) return undefined;
    if (compound !== undefined && where[compound] !== undefined) {
      return where[compound][field];
    }
    return where[field];
  };
}

// --- shared pieces ---------------------------------------------------------

interface WriteColumn {
  field: FieldSchema;
  value: Binder;
}

/**
 * `(cols) values (?, ?), (?, ?)`, or `default values` when the row supplies no
 * column at all — legal on both dialects, and the only way to insert a row made
 * entirely of database defaults.
 */
function valuesClause(grid: WriteColumn[][], dialect: SqlDialect): Fragment {
  const columns = grid[0];
  if (columns.length === 0) return sql(" default values");

  const names = joinFragments(
    columns.map((column) => sql(dialect.quoteIdent(column.field.column))),
    ", ",
  );

  const tuples = grid.map((row) =>
    concat(
      sql("("),
      joinFragments(row.map((column) => param(column.value)), ", "),
      sql(")"),
    ),
  );

  return concat(
    sql(" ("),
    names,
    sql(") values "),
    joinFragments(tuples, ", "),
  );
}

/**
 * Which columns an insert writes, and where each value comes from.
 *
 * The four sources, in the order they are consulted: a nested write that
 * resolved a foreign key, the caller's own `data`, a client-side default, and
 * the database. A required field that reaches the end of that list is an error
 * raised here, naming the field — rather than a `NOT NULL constraint failed`
 * from the driver naming a column and nothing else.
 */
function insertColumns(
  schema: ModelSchema,
  data: unknown,
  contributions: readonly ForeignKeyContribution[],
  op: Operation,
  dialect: SqlDialect,
  locateData: (args: any) => any,
): WriteColumn[] {
  if (data !== undefined && data !== null) {
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new UnsupportedQueryError(
        "data",
        schema.name,
        op,
        "Expected an object.",
      );
    }
  }

  const supplied = suppliedFields(schema, data);
  const contributed = new Map(
    contributions.map((contribution) => [contribution.field, contribution]),
  );

  for (const name of contributed.keys()) {
    if (supplied.has(name)) {
      throw new UnsupportedQueryError(
        `data.${name}`,
        schema.name,
        op,
        `'${name}' is set both directly and through a nested relation write. ` +
          `Prisma keeps those two forms exclusive; use one of them.`,
      );
    }
  }

  const columns: WriteColumn[] = [];

  for (const field of Object.values(schema.fields)) {
    const contribution = contributed.get(field.name);
    if (contribution) {
      columns.push({
        field,
        value: (args, context) =>
          dialect.encode(contribution.value(args, context), field),
      });
      continue;
    }

    if (supplied.has(field.name)) {
      columns.push({
        field,
        value: valueBinder(field, dialect, (args) =>
          locateData(args)?.[field.name],
        ),
      });
      continue;
    }

    if (hasClientSideValue(field)) {
      columns.push({ field, value: defaultBinder(field, dialect) });
      continue;
    }

    // Left out of the statement entirely: the database supplies it, either from
    // its own default or as NULL.
    if (field.default || field.nullable) continue;

    throw new MissingRequiredValueError(schema.name, op, field.name);
  }

  return columns;
}

/** The scalar fields a `data` object actually sets, validated against the schema. */
function suppliedFields(
  schema: ModelSchema,
  data: unknown,
): Set<string> {
  const out = new Set<string>();
  if (typeof data !== "object" || data === null) return out;

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    // Prisma treats an explicit `undefined` as absent, which is how conditional
    // writes are expressed in application code.
    if (value === undefined) continue;
    // Relations are the nested-write planner's business.
    if (key in schema.relations) continue;
    if (!(key in schema.fields)) {
      throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
    }
    out.add(key);
  }

  return out;
}

/**
 * Refuse a statement that would bind more parameters than the driver can carry.
 *
 * `createMany` is the only operation whose parameter count is a function of the
 * caller's *data* rather than of the query's shape, so it is the only one that
 * can walk into a limit an application never chose. Everything else binds a
 * handful.
 *
 * Note this is checked at compile time from the row and column counts, which is
 * enough — the value of any one parameter cannot change how many there are.
 */
function assertParameterCount(
  schema: ModelSchema,
  op: Operation,
  required: number,
  dialect: SqlDialect,
): void {
  const limit = dialect.maxBoundParameters;
  if (required <= limit) return;

  throw new ParameterLimitError(
    schema.name,
    op,
    required,
    limit,
    dialect.name,
    `That is ${required} values across the rows in 'data'.`,
  );
}

/**
 * Refuse a `data` object that names a relation, for the operations that have no
 * nested-write planner behind them.
 *
 * `suppliedFields` skips relation keys rather than rejecting them, because on
 * `create` and `update` they are the nested planner's business. Everywhere else
 * that same skip is a silent drop, so those callers say so here — by name, and
 * before anything is compiled.
 */
function assertNoNestedWrites(
  schema: ModelSchema,
  data: unknown,
  op: Operation,
  path: string,
  reason: string,
): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;

  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (name in schema.relations) {
      throw new UnsupportedQueryError(`${path}.${name}`, schema.name, op, reason);
    }
  }
}

/**
 * `set` assignments for an update, in schema order.
 *
 * `@updatedAt` is appended unless the caller set it explicitly. Applying it on
 * *create* as well is handled by `hasClientSideValue`; missing that half is the
 * easy and quiet version of this bug, since the column is usually NOT NULL and
 * only fails on the models where Prisma made it nullable.
 */
function updateAssignments(
  schema: ModelSchema,
  data: unknown,
  contributions: readonly ForeignKeyContribution[],
  op: Operation,
  dialect: SqlDialect,
  locateData: (args: any) => any = (args) => args?.data,
  /**
   * Prefix for a column read on the *right* of an assignment — `"User".`
   * inside an `on conflict do update`, empty in a plain `update`.
   *
   * Postgres puts both the target row and the proposed `excluded` row in scope
   * inside a conflict clause, so a bare `"n" = "n" + $1` there is rejected:
   * `column reference "n" is ambiguous`. SQLite accepts either form, and so
   * does Postgres in a plain `update` — verified against both — which is why
   * the qualifier is applied where it is needed rather than everywhere.
   */
  qualifier = "",
): Fragment[] {
  if (data !== undefined && data !== null) {
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new UnsupportedQueryError(
        "data",
        schema.name,
        op,
        "Expected an object.",
      );
    }
  }

  const supplied = suppliedFields(schema, data);
  const contributed = new Map(
    contributions.map((contribution) => [contribution.field, contribution]),
  );

  const out: Fragment[] = [];

  for (const field of Object.values(schema.fields)) {
    const column = dialect.quoteIdent(field.column);
    const contribution = contributed.get(field.name);

    if (contribution) {
      out.push(
        concat(
          sql(`${column} = `),
          param((args, context) =>
            dialect.encode(contribution.value(args, context), field),
          ),
        ),
      );
      continue;
    }

    if (supplied.has(field.name)) {
      out.push(
        assignment(
          schema,
          field,
          column,
          `${qualifier}${column}`,
          data,
          op,
          dialect,
          (args) => locateData(args)?.[field.name],
        ),
      );
      continue;
    }

    // Every write stamps `@updatedAt` — that is the whole of the attribute.
    if (field.isUpdatedAt) {
      out.push(
        concat(sql(`${column} = `), param(defaultBinder(field, dialect))),
      );
    }
  }

  return out;
}

/**
 * Prisma's update operators. `set` is the explicit spelling of a plain
 * assignment; the arithmetic four read the column and write it back, so they
 * are the one place a column name appears on the right of an `=`.
 */
const ARITHMETIC: Record<string, string> = {
  increment: "+",
  decrement: "-",
  multiply: "*",
  divide: "/",
};

function assignment(
  schema: ModelSchema,
  field: FieldSchema,
  /** The column as the assignment's target, always unqualified. */
  column: string,
  /** The same column read as a value — qualified inside a conflict clause. */
  source: string,
  data: unknown,
  op: Operation,
  dialect: SqlDialect,
  locate: (args: any) => any,
): Fragment {
  const value = (data as Record<string, unknown>)[field.name];

  if (isOperatorObject(value, field)) {
    const keys = Object.keys(value as Record<string, unknown>).filter(
      (key) => (value as Record<string, unknown>)[key] !== undefined,
    );

    if (keys.length !== 1) {
      throw new UnsupportedQueryError(
        `data.${field.name}`,
        schema.name,
        op,
        `Expected exactly one of ${["set", ...Object.keys(ARITHMETIC)].join(", ")}.`,
      );
    }

    const [key] = keys;
    const at = (args: any) => locate(args)?.[key];

    if (key === "set") {
      return concat(sql(`${column} = `), param(valueBinder(field, dialect, at)));
    }

    return concat(
      sql(`${column} = ${source} ${ARITHMETIC[key]} `),
      param(valueBinder(field, dialect, at)),
    );
  }

  return concat(sql(`${column} = `), param(valueBinder(field, dialect, locate)));
}

/**
 * True for `{ increment: 1 }`, false for a plain value.
 *
 * A `Json` column is excluded because `{ set: ... }` is a legal *value* there as
 * well as an operator, and there is no way to tell them apart structurally.
 * Prisma resolves the ambiguity through its types; we resolve it by treating a
 * Json column's object as data, which is the reading that never loses the
 * caller's value.
 */
function isOperatorObject(value: unknown, field: FieldSchema): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date ||
    ArrayBuffer.isView(value) ||
    field.type === "Json"
  ) {
    return false;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.every((key) => key === "set" || key in ARITHMETIC);
}

function valueBinder(
  field: FieldSchema,
  dialect: SqlDialect,
  locate: (args: any) => any,
): Binder {
  return (args) => dialect.encode(locate(args), field);
}

function defaultBinder(field: FieldSchema, dialect: SqlDialect): Binder {
  // Read per call, never at compile time: a cuid must differ per row and `now`
  // must be the instant of *this* operation, not of the compilation that may
  // have happened thousands of calls ago.
  return (_args, context) =>
    dialect.encode(clientSideValue(field, context.now), field);
}

interface Returning {
  clause: Fragment;
  fields: FieldSchema[];
  hidden?: string[];
  relations: ReturnType<typeof planRelations>["plans"];
}

/**
 * The `RETURNING` list.
 *
 * For a row-returning write it is the caller's `select` — the same resolution a
 * read does — plus any key columns the relation planner or a nested `after`
 * step needs and the caller did not ask for. Those extra columns are stripped
 * from the result once they have been used, exactly as on the read path.
 *
 * For a counting write it is one column, because the count is the number of
 * rows that come back.
 */
function returningClause(
  schema: ModelSchema,
  args: any,
  dialect: SqlDialect,
  op: Operation,
  nested: NestedWritePlanning | undefined,
): Returning {
  if (COUNTING.has(op)) {
    return {
      clause: sql(` returning ${keyColumn(schema, dialect)}`),
      fields: [],
      relations: [],
    };
  }

  const selection = resolveSelection(schema, args, op);
  const { plans, keyFields } = planRelations(schema, args, dialect, op);
  const { fields, hidden } = withKeyFields(schema, selection, [
    ...keyFields,
    ...(nested?.keyFields ?? []),
  ]);

  return {
    clause: concat(
      sql(" returning "),
      joinFragments(
        fields.map((field) => sql(dialect.quoteIdent(field.column))),
        ", ",
      ),
    ),
    fields,
    hidden,
    relations: plans,
  };
}

/** The narrowest column that still identifies a row, for counting writes. */
function keyColumn(schema: ModelSchema, dialect: SqlDialect): string {
  const name = schema.primaryKey[0] ?? Object.keys(schema.fields)[0];
  return dialect.quoteIdent(schema.fields[name].column);
}

function fieldOf(schema: ModelSchema, name: string): FieldSchema {
  const field = schema.fields[name];
  if (!field) {
    throw new UnknownFieldError(name, schema.name, Object.keys(schema.fields));
  }
  return field;
}

function plan(
  statement: Fragment,
  dialect: SqlDialect,
  op: Operation,
  returning: Returning,
  nested: NestedWritePlanning | undefined,
): QueryPlan {
  const { text, binders } = render(statement, dialect);

  const shaper = buildRowShaper(
    returning.fields,
    dialect,
    returning.relations.map((relation) => ({
      key: relation.as,
      kind: relation.kind,
    })),
  );

  const single = SINGLE_ROW.has(op);
  const counting = COUNTING.has(op);

  return {
    text,
    bind: bindValues(binders),
    relations: returning.relations.length > 0 ? returning.relations : undefined,
    hidden: returning.hidden,
    before: nested && nested.before.length > 0 ? nested.before : undefined,
    after: nested && nested.after.length > 0 ? nested.after : undefined,
    shape(rows) {
      // The count *is* the number of returned rows — see the note at the top of
      // this file on why it does not come from driver metadata.
      if (counting) return { count: rows.length };

      const shaped = shaper(rows);
      // `null` when nothing matched. `$exec` turns that into
      // `RecordNotFoundError` for the operations Prisma raises on, where the
      // model's name is in scope for the message.
      return single ? (shaped[0] ?? null) : shaped;
    },
  };
}

function listOf(value: unknown): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function assertArgs(schema: ModelSchema, op: Operation, args: any): void {
  if (args === undefined || args === null) {
    throw new UnsupportedQueryError(
      "args",
      schema.name,
      op,
      `${op} requires arguments.`,
    );
  }

  if (typeof args !== "object" || Array.isArray(args)) {
    throw new UnsupportedQueryError(
      String(args),
      schema.name,
      op,
      "Expected an object.",
    );
  }

  if (args.select !== undefined && args.include !== undefined) {
    throw new UnsupportedQueryError(
      "select + include",
      schema.name,
      op,
      "Prisma allows only one of them on the same query.",
    );
  }

  const allowed = WRITE_ARGS[op];
  for (const key of Object.keys(args).sort()) {
    if (args[key] === undefined) continue;
    if (!allowed.has(key)) {
      throw new UnsupportedQueryError(key, schema.name, op);
    }
  }

  for (const required of requiredArgs(op)) {
    if (args[required] === undefined) {
      throw new UnsupportedQueryError(
        required,
        schema.name,
        op,
        `${op} requires '${required}'.`,
      );
    }
  }
}

/**
 * Which arguments Prisma makes non-optional, matched exactly.
 *
 * `updateMany` and `deleteMany` take an *optional* `where` — `deleteMany({})`
 * legitimately empties a table. Requiring one here would be a safety rail
 * Prisma does not have, and the differential harness would call it a
 * divergence, which is the right verdict: a guard belongs in a policy
 * (iteration 6), not in the compiler.
 */
function requiredArgs(op: Operation): string[] {
  switch (op) {
    case "create":
    case "createMany":
      return ["data"];
    case "update":
      return ["data", "where"];
    case "updateMany":
      return ["data"];
    case "delete":
      return ["where"];
    case "upsert":
      return ["where", "create", "update"];
    default:
      return [];
  }
}
