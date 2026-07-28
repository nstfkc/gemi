import { UnsupportedQueryError } from "../errors";
import type { SqlDialect } from "../dialect";
import type { ModelSchema, RelationSchema } from "../schema";
import type { Binder } from "./fragment";
import {
  type Link,
  type NestedWriteStep,
  relatedSchema,
  resolveLink,
} from "./plan-relations";
import { matchUniqueKey } from "./unique";

/**
 * Nested writes: `connect` and shallow `create`, and nothing else.
 *
 * Which direction a nested write runs in is decided by *who holds the foreign
 * key*, and the two directions are genuinely different operations:
 *
 * ```ts
 * // this model holds organizationId — resolve the key, then insert once
 * User.create({ data: { email, organization: { connect: { id: 1 } } } })
 *
 * // Account holds userId — insert the user, then insert accounts pointing at it
 * User.create({ data: { email, accounts: { create: [{ ... }] } } })
 * ```
 *
 * The first is a `before` step (or, in the common case, no step at all — just a
 * column read straight out of the argument tree). The second is an `after` step,
 * because the key it needs does not exist until the parent row does.
 *
 * Everything else in Prisma's nested-write grammar — `connectOrCreate`, `set`,
 * `disconnect`, `update`, `upsert`, `delete`, `deleteMany`, `updateMany`,
 * `createMany` — throws `UnsupportedQueryError` naming the operation. Deep
 * nested writes carry real ordering and cascade semantics and are a feature in
 * their own right; smuggling half of them in here would mean shipping the
 * ordering bugs without the feature.
 *
 * NOT ATOMIC. See the note on `NestedWriteStep`: every step past the first is a
 * separate statement with no transaction around it until iteration 5.
 */

const SUPPORTED = new Set(["connect", "create"]);

/** A foreign-key column on *this* model that a nested write supplies. */
export interface ForeignKeyContribution {
  /** The field name on this model — `organizationId`. */
  field: string;
  /** Produces the value at bind time, already unencoded. */
  value: Binder;
}

export interface NestedWritePlanning {
  contributions: ForeignKeyContribution[];
  before: NestedWriteStep[];
  after: NestedWriteStep[];
  /**
   * Fields of *this* model that the statement must return, because an `after`
   * step needs them to point its children at this row.
   */
  keyFields: string[];
}

const EMPTY: NestedWritePlanning = {
  contributions: [],
  before: [],
  after: [],
  keyFields: [],
};

export function planNestedWrites(
  schema: ModelSchema,
  data: unknown,
  operation: string,
  /** Re-locates `data` inside the call's argument tree at bind time. */
  locateData: (args: any) => any,
  /**
   * Needed only by the implicit many-to-many path, which emits statements
   * against a table with no model and therefore has no `Fragment` pipeline to
   * number its placeholders — SQLite writes `?` and Postgres `$1`.
   */
  dialect: SqlDialect,
): NestedWritePlanning {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return EMPTY;
  }

  const entries = Object.keys(data as Record<string, unknown>)
    .sort()
    .filter((key) => key in schema.relations)
    .filter((key) => (data as Record<string, unknown>)[key] !== undefined);

  if (entries.length === 0) return EMPTY;

  const planning: NestedWritePlanning = {
    contributions: [],
    before: [],
    after: [],
    keyFields: [],
  };

  for (const key of entries) {
    const relation = schema.relations[key];
    const node = (data as Record<string, unknown>)[key];
    const locate = (args: any) => locateData(args)?.[key];

    planOne(schema, relation, node, operation, locate, planning, dialect);
  }

  return planning;
}

function planOne(
  schema: ModelSchema,
  relation: RelationSchema,
  node: unknown,
  operation: string,
  locate: (args: any) => any,
  out: NestedWritePlanning,
  dialect: SqlDialect,
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new UnsupportedQueryError(
      `data.${relation.name}`,
      schema.name,
      operation,
      "Expected an object holding 'connect' or 'create'.",
    );
  }

  const keys = Object.keys(node as Record<string, unknown>)
    .sort()
    .filter((key) => (node as Record<string, unknown>)[key] !== undefined);

  if (keys.length === 0) return;

  const child = relatedSchema(schema, relation);
  const link = resolveLink(schema, child, relation);

  // An implicit many-to-many is *neither* side: the keys live in a third table
  // with no model, so both directions are the same work and the operand set is
  // wider — `disconnect` and `set` are a delete against the join table, which
  // needs no schema to compile.
  if (link.join) {
    for (const key of keys) {
      planJoinTable(
        schema,
        relation,
        child,
        link,
        key,
        (node as Record<string, unknown>)[key],
        operation,
        (args: any) => locate(args)?.[key],
        out,
        dialect,
      );
    }
    return;
  }

  for (const key of keys) {
    if (!SUPPORTED.has(key)) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.${key}`,
        schema.name,
        operation,
        `Only 'connect' and 'create' are implemented. Deep nested writes are ` +
          `a later iteration.`,
      );
    }
  }

  // `from` is non-empty exactly on the side that holds the foreign key.
  const owning = relation.from.length > 0;

  for (const key of keys) {
    const operand = (node as Record<string, unknown>)[key];
    const at = (args: any) => locate(args)?.[key];

    if (owning) {
      planOwningSide(
        schema,
        relation,
        child,
        link,
        key,
        operand,
        operation,
        at,
        out,
      );
    } else {
      planForeignSide(
        schema,
        relation,
        child,
        link,
        key,
        operand,
        operation,
        at,
        out,
      );
    }
  }
}

/**
 * This model holds the foreign key, so the far row must exist — or be created —
 * before the insert can bind, and the whole thing collapses to one extra column.
 */
function planOwningSide(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  link: { parentField: string; childField: string },
  key: string,
  operand: unknown,
  operation: string,
  at: (args: any) => any,
  out: NestedWritePlanning,
): void {
  // `link.parentField` is the FK on this model; `link.childField` is what it
  // references on the other one.
  const fkField = link.parentField;
  const referenced = link.childField;

  if (key === "create") {
    // The far row does not exist yet: create it first, through its own model's
    // `$exec` so it is subject to everything a top-level create is (invariant 1).
    out.before.push({
      relation: relation.name,
      operation: "create",
      async run(args, context, executor) {
        const created = (await executor.exec(
          relation.model,
          "create",
          { data: at(args), select: { [referenced]: true } },
          // NOT pre-scoped. Nothing walks `data.<relation>.create`, so the
          // child's own `onCreate` is the only thing that can scope this row.
          false,
        )) as Record<string, unknown> | null;

        context.resolved[fkField] = created?.[referenced] ?? null;
      },
    });
    out.contributions.push({
      field: fkField,
      value: (_args, context) => context.resolved[fkField],
    });
    return;
  }

  // `connect`. In the common case the caller already handed us the referenced
  // value — `connect: { id: 1 }` where the relation references `id` — and no
  // query is needed at all: it is one more bound column.
  //
  // Whether that is the case is a property of the argument *shape*, not of its
  // values, so the choice is made here at compile time and the two forms are two
  // plans. That is what keeps a `connect` from silently costing a round trip.
  if (
    typeof operand !== "object" ||
    operand === null ||
    Array.isArray(operand)
  ) {
    throw new UnsupportedQueryError(
      `data.${relation.name}.connect`,
      schema.name,
      operation,
      "Expected an object naming a unique field.",
    );
  }

  const direct =
    (operand as Record<string, unknown>)[referenced] !== undefined &&
    Object.keys(operand as Record<string, unknown>).filter(
      (name) => (operand as Record<string, unknown>)[name] !== undefined,
    ).length === 1;

  if (direct) {
    out.contributions.push({
      field: fkField,
      value: (args) => at(args)?.[referenced],
    });
    return;
  }

  // `connect: { publicId: "..." }` against a relation that references `id`:
  // Prisma resolves it with a lookup, and so do we. Validated now so a
  // non-unique connect target fails at compile time rather than matching an
  // arbitrary row.
  matchUniqueKey(child, operand, `${operation}.${relation.name}.connect`);

  out.before.push({
    relation: relation.name,
    operation: "connect",
    async run(args, context, executor) {
      const found = (await executor.exec(
        relation.model,
        "findUniqueOrThrow",
        { where: at(args), select: { [referenced]: true } },
        // NOT pre-scoped. This lookup reads another model's rows to decide what
        // to attach, so it is that model's policies that say which rows exist —
        // otherwise a `connect` by any unique key reaches every tenant's.
        false,
      )) as Record<string, unknown> | null;

      context.resolved[fkField] = found?.[referenced] ?? null;
    },
  });
  out.contributions.push({
    field: fkField,
    value: (_args, context) => context.resolved[fkField],
  });
}

/**
 * The *child* holds the foreign key, so nothing can be written until this row
 * exists and its key is known. Both forms are therefore `after` steps, and both
 * need the key in the statement's `RETURNING` list.
 */
function planForeignSide(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  link: { parentField: string; childField: string },
  key: string,
  operand: unknown,
  operation: string,
  at: (args: any) => any,
  out: NestedWritePlanning,
): void {
  const parentField = link.parentField;
  const childField = link.childField;

  out.keyFields.push(parentField);

  if (key === "create") {
    out.after.push({
      relation: relation.name,
      operation: "create",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        // No row means the statement matched nothing; `update` and `delete`
        // raise before this runs, so there is nothing to attach to.
        if (!parent) return;

        for (const item of listOf(at(args))) {
          await executor.exec(
            relation.model,
            "create",
            {
              // The foreign key is set by us, not by the caller: a nested create
              // that also named it would be describing two different parents.
              data: { ...(item as object), [childField]: parent[parentField] },
              // Nothing reads the result, and the narrowest select keeps the
              // returned payload from growing with the child's column count.
              select: { [childField]: true },
            },
            // NOT pre-scoped — the child's `onCreate` is what scopes this row.
            false,
          );
        }
      },
    });
    return;
  }

  // `connect` on this side means "point that existing row at me", which is an
  // update of the child's foreign key — not something this row's insert can do.
  out.after.push({
    relation: relation.name,
    operation: "connect",
    async run(args, _context, executor, rows) {
      const parent = rows[0];
      if (!parent) return;

      for (const item of listOf(at(args))) {
        matchUniqueKey(child, item, `${operation}.${relation.name}.connect`);
        await executor.exec(
          relation.model,
          "update",
          {
            where: item,
            data: { [childField]: parent[parentField] },
            select: { [childField]: true },
          },
          // NOT pre-scoped. Repointing an existing row at this parent is a write
          // to the child, and the child's scope decides which rows are reachable
          // — otherwise `connect` re-parents another tenant's row.
          false,
        );
      }
    },
  });
}

/** What an implicit many-to-many accepts, which is wider than an ordinary relation. */
const JOIN_TABLE_SUPPORTED = new Set([
  "connect",
  "disconnect",
  "set",
  "create",
]);

/**
 * Writes through Prisma's implicit many-to-many join table.
 *
 * The table has **no model**: no registered class, no generated base, no
 * `$schema` — just `_PostToTag` with an `A` and a `B` column, named from the
 * two model names in alphabetical order, with the pair as its primary key. So
 * the two operands that work for an ordinary relation have nothing to compile
 * *to*, and these statements are emitted directly, the way the read side's
 * `readPairs` already does.
 *
 * Which column is which end comes from `resolveLink`, never from declaration
 * order. That distinction is invisible on `Post` / `Tag` and wrong on a
 * self-relation, where both ends are the same model and only the *field* name
 * separates them.
 *
 * Every operand is an `after` step: the pair cannot be written until this row
 * has a key. Two of them are more than one statement — `set` deletes before it
 * inserts — and `$exec` already opens a transaction for any plan carrying
 * steps, so the whole thing is atomic.
 *
 * **The rows the pairs point at are still read and written through the child's
 * own `$exec`**, so a `connect` cannot reach a row the child's policies hide,
 * and a `create` gets the child's `onCreate`. Only the join table itself —
 * which has no model and nothing an application could scope — is written
 * directly.
 */
function planJoinTable(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  link: Link,
  key: string,
  operand: unknown,
  operation: string,
  at: (args: any) => any,
  out: NestedWritePlanning,
  dialect: SqlDialect,
): void {
  if (!JOIN_TABLE_SUPPORTED.has(key)) {
    throw new UnsupportedQueryError(
      `data.${relation.name}.${key}`,
      schema.name,
      operation,
      `'${relation.name}' is an implicit many-to-many. Only ` +
        `${[...JOIN_TABLE_SUPPORTED].sort().join(", ")} are implemented ` +
        `through its join table.`,
    );
  }

  const join = link.join!;
  const parentField = link.parentField;
  const childField = link.childField;

  // `dialect.quoteIdent`, not a local helper. It does the same escaping *and*
  // rejects a NUL byte, which exists because NUL is the parameter sentinel in
  // `compile/fragment.ts`. Prisma generates these identifiers so nothing can
  // reach that check today — but this is the one file emitting SQL without the
  // `Fragment` pipeline, which makes it the one most worth holding to the rule
  // rather than the one to excuse from it.
  const quoted = (name: string) => dialect.quoteIdent(name);

  out.keyFields.push(parentField);

  out.after.push({
    relation: relation.name,
    operation: key === "create" ? "create" : "connect",
    async run(args, _context, executor, rows) {
      const parent = rows[0];
      if (!parent) return;

      const parentKey = parent[parentField];
      if (parentKey === null || parentKey === undefined) return;

      // `set` replaces the whole set, so what is there now goes first — but
      // **only the part of it this caller can see**.
      //
      // A bare `delete … where "A" = ?` removes every pair, including ones
      // pointing at children the child model's policies hide, and nothing on
      // that path consults the child. `disconnect` right below refuses the same
      // effect when it is named explicitly — it resolves through the child's
      // own `findUniqueOrThrow`, which raises for a row the caller cannot see —
      // so an unscoped `set` would make the authorization boundary disagree
      // with itself depending on which operand you reached for.
      //
      // Not a read leak: nothing comes back, and the caller cannot tell a
      // hidden link existed. It is an unscoped *write* to state they could not
      // otherwise reach, which is the thing this layer exists to prevent.
      //
      // So the existing links are read, filtered through the child's own
      // `findMany` — where its scope applies exactly as it does anywhere else —
      // and only those are deleted. `set` therefore means "replace the set I
      // can see", which is what every other policy in this ORM does: narrow,
      // never widen. With no policy on the child, every link is visible and
      // this is byte-for-byte the old behaviour, so Prisma parity is unchanged
      // wherever there is no policy to apply.
      if (key === "set") {
        const linked = (await executor.query(
          `select ${quoted(join.childColumn)} from ${quoted(join.table)} ` +
            `where ${quoted(join.parentColumn)} = ${dialect.placeholder(0)}`,
          [parentKey],
        )) as Record<string, unknown>[];

        const existing = Array.from(linked, (row) => row[join.childColumn]);

        if (existing.length > 0) {
          const visible = (await executor.exec(
            relation.model,
            "findMany",
            {
              where: { [childField]: { in: existing } },
              select: { [childField]: true },
            },
            // NOT pre-scoped: the child's scope is the whole point here.
            false,
          )) as Record<string, unknown>[];

          // One statement, not one per link. The scoped form is a `delete`
          // over an `in` list rather than a loop, because this repo counts
          // *statements*: `plans/orm/benchmarks.md` measures include trees that
          // way, and the lateral strategy exists to remove `N - 1` of them. A
          // loop here would have made `set` the one write that reintroduces
          // them — invisible on SQLite, where round trips are in-process, and
          // paid in full on Postgres, where they are not.
          //
          // Placeholders are built per length rather than bound as one array
          // parameter. `dialect.inList` does the latter on Postgres, but it
          // returns a `Fragment` and this is the one path that emits SQL
          // without that pipeline — there is no model to route the join table
          // through. The cost is one server-side plan per distinct link count;
          // the ORM's own plan cache is unaffected, since it keys on the
          // argument shape and this text never reaches it.
          const targets = Array.from(visible, (row) => row[childField]);

          // Every existing link points at a row this caller cannot see, so
          // there is nothing to clear and `in ()` is a syntax error on both
          // dialects. The loop this replaced degenerated to zero iterations
          // here; the single statement has to say so explicitly.
          if (targets.length > 0) {
            await runPairStatement(
              executor,
              `delete from ${quoted(join.table)} where ` +
                `${quoted(join.parentColumn)} = ${dialect.placeholder(0)} and ` +
                `${quoted(join.childColumn)} in (` +
                targets
                  .map((_, index) => dialect.placeholder(index + 1))
                  .join(", ") +
                `)`,
              [parentKey, ...targets],
            );
          }
        }
      }

      const items = listOf(at(args));
      if (items.length === 0) return;

      const childKeys: unknown[] = [];

      for (const item of items) {
        if (key === "create") {
          const created = (await executor.exec(
            relation.model,
            "create",
            { data: item, select: { [childField]: true } },
            // NOT pre-scoped: the child's own `onCreate` is what scopes the row.
            false,
          )) as Record<string, unknown> | null;
          if (created) childKeys.push(created[childField]);
          continue;
        }

        // `connect`, `disconnect` and `set` all name existing rows by a unique
        // key. Resolved through the child's own `$exec`, so its policies decide
        // which rows exist — otherwise a connect by any unique key reaches
        // every tenant's.
        matchUniqueKey(child, item, `${operation}.${relation.name}.${key}`);
        const found = (await executor.exec(
          relation.model,
          "findUniqueOrThrow",
          { where: item, select: { [childField]: true } },
          false,
        )) as Record<string, unknown> | null;
        if (found) childKeys.push(found[childField]);
      }

      for (const childKey of childKeys) {
        if (key === "disconnect") {
          await runPairStatement(
            executor,
            `delete from ${quoted(join.table)} where ` +
              `${quoted(join.parentColumn)} = ${dialect.placeholder(0)} and ` +
              `${quoted(join.childColumn)} = ${dialect.placeholder(1)}`,
            [parentKey, childKey],
          );
          continue;
        }

        // `on conflict do nothing`, because the pair is the join table's
        // primary key and Prisma treats a repeated `connect` as a no-op rather
        // than an error. Without it the second connect of the same pair is a
        // raw driver unique violation, which is neither Prisma's behaviour nor
        // a useful one. Both dialects spell it the same way — SQLite has had it
        // since 3.24 — so this needs no dialect branch.
        await runPairStatement(
          executor,
          `insert into ${quoted(join.table)} ` +
            `(${quoted(join.parentColumn)}, ${quoted(join.childColumn)}) ` +
            `values (${dialect.placeholder(0)}, ${dialect.placeholder(1)}) ` +
            `on conflict do nothing`,
          [parentKey, childKey],
        );
      }
    },
  });
}

/**
 * One statement against a table with no model, on the connection this call
 * resolved — which is what keeps it inside the caller's transaction.
 *
 * Placeholders come from the dialect rather than being hardcoded, for the same
 * reason `readPairs` renders its statement: SQLite writes `?` and Postgres
 * `$1`, and this path has no `Fragment` pipeline to do it automatically.
 */
async function runPairStatement(
  executor: { query(text: string, values: unknown[]): Promise<unknown> },
  text: string,
  values: unknown[],
): Promise<void> {
  await executor.query(text, values);
}

/**
 * Prisma accepts both a single object and an array everywhere a to-many nested
 * write is legal, and the singular form is the common one on a to-one.
 */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
