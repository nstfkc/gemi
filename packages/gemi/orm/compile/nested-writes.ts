import { UnsupportedQueryError } from "../errors";
import type { SqlDialect } from "../dialect";
import type { ModelSchema, RelationSchema } from "../schema";
import type { Binder } from "./fragment";
import {
  type Link,
  type NestedWriteStep,
  relatedSchema,
  resolveLink,
  singleFieldLink,
} from "./plan-relations";
import { matchUniqueKey } from "./unique";

/**
 * Nested writes: `connect`, `connectOrCreate`, shallow `create`, and
 * `createMany`.
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
 * `createMany` is the second shape and only exists on the foreign side: the same
 * rows as a nested `create`, in one statement rather than one per row.
 *
 * Everything else in Prisma's nested-write grammar — `set`, `disconnect`,
 * `update`, `upsert`, `delete`, `deleteMany`, `updateMany` — throws
 * `UnsupportedQueryError` naming the operation *and the reason*; see `REFUSED`.
 *
 * **The line this file draws has two halves: which rows an operand can name,
 * and whose columns it writes.**
 *
 * Every supported operand names its rows — a new one, or an existing one the
 * caller identified by unique key — so it goes through the child's own
 * `findUnique`, `create` or `update`, and the child's policies decide whether
 * it is reachable at all. `set`, `disconnect`, `delete`, `deleteMany` and
 * `updateMany` act on rows the *call* did not name, and "whatever is there" has
 * no lookup to hang a scope on.
 *
 * `update` is the operand that shows the second half is needed, because it
 * *does* name its row: `update: { where, data }`. It is refused because of what
 * it writes — caller-supplied columns, which need the child's `onUpdate` and
 * the scope-escape guard run over the payload. Every supported operand writes
 * either a whole new row through the child's `create` (where `onCreate`
 * applies) or one foreign key the ORM itself chose.
 *
 * This used to say the line was "each writes rows that **already exist**", and
 * that was true until `connectOrCreate` arrived: on the foreign side a hit is
 * an `update` of the child's foreign key, because Prisma repoints the existing
 * row rather than duplicating it. So a supported operand does now write a row
 * that was already there. Restated rather than deleted, because the criterion
 * is what the next operand gets judged against — #75 built the whole `REFUSED`
 * table on it, with a per-entry reason derived from it, and #83's `set` on an
 * implicit many-to-many was fixed by exactly this reading: scope the delete to
 * the rows the caller can see. A stale criterion is worse than none, because it
 * is the one the next reader applies.
 *
 * Atomic since iteration 5: `$exec` opens a transaction for any plan carrying
 * steps, so a nested step that fails — or a child policy that denies — rolls
 * back the parent row too.
 */

const SUPPORTED = new Set([
  "connect",
  "connectOrCreate",
  "create",
  "createMany",
]);

/**
 * The operands still refused, and what each would take.
 *
 * Named individually rather than covered by one message, because "not
 * implemented" is much less useful than knowing whether the thing you reached
 * for is a rewrite or a wait. Each of these is a *write to rows that already
 * exist*, which is the line: everything supported writes new rows or repoints a
 * key, and none of it has to reason about what was there before.
 */
const REFUSED: Record<string, string> = {
  set: `It replaces the whole set, so it has to disconnect what is there now.`,
  disconnect: `It clears a foreign key on rows this call did not name.`,
  delete: `It deletes rows this call did not name.`,
  deleteMany: `It deletes rows this call did not name.`,
  // Not "it writes a row that already exists" — `connectOrCreate` does that
  // too, on the foreign side, and is supported. The difference is *whose*
  // columns: this one writes caller-supplied data, so the child's `onUpdate`
  // and the scope-escape guard both have to run over it, where a `connect`
  // writes one foreign key the ORM chose.
  update:
    `It writes caller-supplied columns to a row that already exists, so the ` +
    `child's 'onUpdate' and the scope-escape guard have to run over the ` +
    `payload — a pass this does not have yet.`,
  updateMany:
    `It writes caller-supplied columns to rows this call did not name, so it ` +
    `needs both halves: a scope on which rows match, and the child's ` +
    `'onUpdate' over the payload.`,
  upsert:
    `It is 'update' and 'connectOrCreate' at once, and only the second half ` +
    `is implemented.`,
};

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

  // Sorted, and it is load-bearing twice over. The plan cache needs it — two
  // argument objects differing only in key order must be one plan — and the
  // *order the steps run in* falls out of it, because they are pushed in this
  // order and run in that order.
  //
  // Only one pair is order-sensitive today, and it happens to sort the right
  // way: `create` before `createMany` is what Prisma does, verified from the
  // ids it hands back. `connect` before `createMany` is the other pair and its
  // order is not observable — repointing an existing child and inserting new
  // ones do not interact — but it is pinned by a differential case rather than
  // left to be rediscovered.
  //
  // So: this is a coincidence that is currently correct. An operand added here
  // whose order *is* observable cannot rely on the alphabet and has to sequence
  // itself explicitly.
  const keys = Object.keys(node as Record<string, unknown>)
    .sort()
    .filter((key) => (node as Record<string, unknown>)[key] !== undefined);

  if (keys.length === 0) return;

  const child = relatedSchema(schema, relation);

  // **Narrowed to one field, deliberately.** Reading across a composite
  // relation works (#67); writing through one would have to contribute that
  // many foreign-key columns to this insert, which is a different piece of
  // work — so it is refused here by name rather than silently writing the
  // first field. The narrowing is a function call rather than an index, so
  // there is no single-field property on `Link` to reach for by accident.
  //
  // Safe to do before the join-table branch below: an implicit many-to-many
  // links parent and child by their primary keys, one field each side, so the
  // narrowing never refuses one — and it carries `join` through untouched.
  const link = singleFieldLink(
    resolveLink(schema, child, relation, operation),
    schema,
    relation,
    operation,
  );

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
      const why = REFUSED[key];
      throw new UnsupportedQueryError(
        `data.${relation.name}.${key}`,
        schema.name,
        operation,
        `Only 'connect', 'create' and 'createMany' are implemented.` +
          (why ? ` '${key}' is not: ${why}` : ""),
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

  // This side is a to-one by construction — it holds a single foreign key — so
  // there is nothing for a `createMany` to write many of. Prisma does not offer
  // it here either; refused with the reason rather than the grammar, because a
  // caller who reached for it has the direction of the relation wrong.
  // The *other* half of this refusal is in `planForeignSide`, which reaches the
  // same conclusion from the far side of the key: a one-to-one whose child
  // holds the foreign key is still a to-one. Both are reachable and neither
  // subsumes the other, so the message is duplicated rather than shared.
  if (key === "createMany") {
    throw new UnsupportedQueryError(
      `data.${relation.name}.createMany`,
      schema.name,
      operation,
      `'${relation.name}' is a to-one: this row holds the foreign key, so ` +
        `there is one related row at most and nothing to create many of. ` +
        `Prisma does not accept it here either.`,
    );
  }

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

  /**
   * `connectOrCreate` — find the row by a unique key, and create it only if it
   * is not there.
   *
   * **A hit ignores `create` entirely**, which is not what the name suggests
   * and is worth pinning: it is `connect`-or-create, not upsert. Measured — an
   * existing organisation kept its own name where the `create` payload named a
   * different one.
   *
   * `findUnique`, not `findUniqueOrThrow`: a miss is the *other branch* here,
   * where for a plain `connect` it is an error.
   *
   * Object only on this side. The relation holds one foreign key, so there is
   * one row to point at, and Prisma refuses an array here too.
   */
  if (key === "connectOrCreate") {
    assertConnectOrCreateOperand(
      schema,
      relation,
      child,
      operand,
      operation,
      false,
    );

    out.before.push({
      relation: relation.name,
      operation: "connectOrCreate",
      async run(args, context, executor) {
        const where = at(args)?.where;

        const found = (await executor.exec(
          relation.model,
          "findUnique",
          { where, select: { [referenced]: true } },
          // NOT pre-scoped, for the reason `connect` is not: this reads another
          // model's rows to decide what to attach, so that model's policies say
          // which rows exist. Scoped away, a hit becomes a miss and the row is
          // *created* — so the fallback branch is what keeps this from being a
          // way to observe another tenant's keys.
          false,
        )) as Record<string, unknown> | null;

        if (found) {
          context.resolved[fkField] = found[referenced] ?? null;
          return;
        }

        const created = (await executor.exec(
          relation.model,
          "create",
          { data: at(args)?.create, select: { [referenced]: true } },
          // NOT pre-scoped — the child's own `onCreate` scopes the new row.
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

  /**
   * `createMany`: the same rows as a nested `create`, in **one statement**.
   *
   * The biggest single item on #65 — parent-and-children in one call — and the
   * work is sequencing rather than SQL: `compileCreateMany` already exists, and
   * the parent's `RETURNING` already yields the key the children need. What this
   * step adds is running it once with the key stamped onto every row, instead of
   * once per row.
   *
   * That difference is the point. A nested `create` of forty rows is forty
   * statements; this is one, which is what makes the shape worth porting rather
   * than rewriting into a transaction with explicit foreign keys.
   */
  if (key === "createMany") {
    // The mirror of `planOwningSide`'s guard: that one catches a to-one whose
    // foreign key is on *this* row, this one catches a one-to-one whose key is
    // on the child. Same conclusion, different direction, and both reachable.
    if (relation.kind !== "many") {
      throw new UnsupportedQueryError(
        `data.${relation.name}.createMany`,
        schema.name,
        operation,
        `'${relation.name}' is a to-one, so there is nothing to create many ` +
          `of. Prisma does not accept it here either.`,
      );
    }

    assertCreateManyOperand(schema, relation, operand, operation);

    out.after.push({
      relation: relation.name,
      operation: "createMany",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const items = listOf(at(args)?.data).map((item) => ({
          // Same rule as the nested `create` beside this one: the foreign key
          // is ours to set, not the caller's. Prisma leaves it out of the
          // nested input type entirely, so a row naming it is describing a
          // different parent than the call is.
          ...(item as object),
          [childField]: parent[parentField],
        }));

        // **No short-circuit on an empty list**, and that is worth the round
        // trip it costs.
        //
        // Returning early here would skip the child's `$exec`, and with it the
        // child's *policies* — so whether the ORM refuses a misconfigured
        // policy would depend on the length of an array at run time. A model
        // carrying a `scope` with no `onCreate` is refused on the call with one
        // row and accepted on the call with none, which means the
        // misconfiguration hides behind data that happens to be empty in
        // development and reports itself on the first request whose list is
        // not. Nothing is written either way, so it is not a leak — it is a
        // refusal that arrives late, which is the thing the rest of the
        // compiler is arranged to prevent by deciding everything from the
        // argument *shape*.
        //
        // The cost is one `select … where false`, which is what
        // `compileCreateMany` emits for an empty list. Prisma does accept the
        // empty list and write nothing — verified — and so does this.
        await executor.exec(
          relation.model,
          "createMany",
          { data: items },
          // NOT pre-scoped. `createMany` is in the set an `onCreate` applies
          // to, and it applies per row — so the child's policy stamps the
          // tenant column onto every one of these, exactly as it would for a
          // top-level `createMany`.
          false,
        );
      },
    });
    return;
  }

  /**
   * `connectOrCreate` on this side is the pair of branches the owning side has,
   * with `connect` spelled as an update of the child's foreign key.
   *
   * Both branches go through the child's own `$exec`, so both are scoped by the
   * child's policies — and they have to be, in opposite directions: an
   * unscopeable *update* would re-parent another tenant's row, and an unscoped
   * *read* would let a hit reveal that a row with that key exists. Scoped, a
   * hidden row reads as absent and the call creates its own, which is the same
   * answer the caller would get if it truly did not exist.
   */
  if (key === "connectOrCreate") {
    assertConnectOrCreateOperand(
      schema,
      relation,
      child,
      operand,
      operation,
      true,
    );

    out.after.push({
      relation: relation.name,
      operation: "connectOrCreate",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const list = listOf(at(args));

        for (let index = 0; index < list.length; index++) {
          const item = list[index] as Record<string, unknown>;

          const found = (await executor.exec(
            relation.model,
            "findUnique",
            { where: item.where, select: { [childField]: true } },
            false,
          )) as Record<string, unknown> | null;

          if (found) {
            await executor.exec(
              relation.model,
              "update",
              {
                where: item.where,
                data: { [childField]: parent[parentField] },
                select: { [childField]: true },
              },
              false,
            );
            continue;
          }

          await executor.exec(
            relation.model,
            "create",
            {
              // The foreign key is ours, not the caller's — the same rule the
              // nested `create` above follows, and Prisma leaves it out of the
              // nested input type entirely.
              data: {
                ...(item.create as object),
                [childField]: parent[parentField],
              },
              select: { [childField]: true },
            },
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
  link: { parentField: string; childField: string; join?: Link["join"] },
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
 * `connectOrCreate`'s operand: `{ where, create }`, or a list of them on a
 * to-many.
 *
 * Validated at plan time so a misspelled key fails when the query is compiled,
 * rather than after the parent row has been written and the transaction has to
 * unwind it — the same reason `createMany`'s operand is checked here.
 *
 * The `where` has to be a unique key, which is Prisma's rule and not merely
 * ours: without it the lookup matches an arbitrary row and "connect or create"
 * silently becomes "connect to whichever one came back first".
 */
function assertConnectOrCreateOperand(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  operation: string,
  many: boolean,
): Record<string, unknown>[] {
  const at = `data.${relation.name}.connectOrCreate`;

  if (Array.isArray(operand) && !many) {
    throw new UnsupportedQueryError(
      at,
      schema.name,
      operation,
      `'${relation.name}' is a to-one: this row holds the foreign key, so ` +
        `there is one row to point at and a list has no meaning. Prisma ` +
        `refuses an array here too.`,
    );
  }

  const entries = (Array.isArray(operand) ? operand : [operand]) as unknown[];

  if (entries.length === 0) return [];

  const out: Record<string, unknown>[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        `Expected an object with 'where' and 'create'.`,
      );
    }

    const record = entry as Record<string, unknown>;

    for (const required of ["where", "create"] as const) {
      if (record[required] === undefined) {
        throw new UnsupportedQueryError(
          at,
          schema.name,
          operation,
          `Expected a '${required}' key — 'connectOrCreate' names the row to ` +
            `look for and the row to write if it is not there.`,
        );
      }
    }

    const extra = Object.keys(record).filter(
      (key) => key !== "where" && key !== "create" && record[key] !== undefined,
    );
    if (extra.length > 0) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        `Unexpected ${extra.sort().join(", ")} — 'connectOrCreate' takes ` +
          `'where' and 'create'.`,
      );
    }

    matchUniqueKey(child, record.where, `${operation}.${relation.name}.connectOrCreate`);
    out.push(record);
  }

  return out;
}

/**
 * `createMany`'s operand is `{ data }` — not the rows directly, which is the
 * one place Prisma's nested grammar adds a level.
 *
 * Checked at plan time, so a misspelled key fails when the query is compiled
 * rather than after the parent row has already been written and the transaction
 * has to unwind it.
 */
function assertCreateManyOperand(
  schema: ModelSchema,
  relation: RelationSchema,
  operand: unknown,
  operation: string,
): void {
  const at = `data.${relation.name}.createMany`;

  if (typeof operand !== "object" || operand === null || Array.isArray(operand)) {
    throw new UnsupportedQueryError(
      at,
      schema.name,
      operation,
      `Expected an object with a 'data' key — the rows go inside it, not ` +
        `directly under 'createMany'.`,
    );
  }

  const keys = Object.keys(operand as Record<string, unknown>).filter(
    (key) => (operand as Record<string, unknown>)[key] !== undefined,
  );

  if (!keys.includes("data")) {
    throw new UnsupportedQueryError(at, schema.name, operation, `Expected a 'data' key.`);
  }

  for (const key of keys) {
    if (key === "data") continue;

    // `skipDuplicates` is the one a caller will actually reach for, so it gets
    // the reason instead of the generic message.
    //
    // **Scoped to the nested form on purpose.** This used to say "at any
    // level", which was true when it was written and stops being true the
    // moment #69 lands: a top-level `Account.createMany({ data, skipDuplicates
    // })` compiles to `on conflict do nothing` on Postgres. Naming the level
    // keeps the sentence true either way, and points at the spelling that
    // works today rather than at a wait.
    //
    // Whether the nested form should simply pass it through is a real question
    // and not this change's: the step below already calls the child's own
    // `$exec("createMany", …)`, so forwarding the flag is close to free — but
    // it would need the top-level support to exist first, and until then it
    // would fail with an error about an unknown argument on a model the caller
    // did not name.
    throw new UnsupportedQueryError(
      `${at}.${key}`,
      schema.name,
      operation,
      key === "skipDuplicates"
        ? `'skipDuplicates' is not implemented on a *nested* 'createMany'. ` +
          `Write the children with their own '${relation.model}.createMany' ` +
          `call, which takes it.`
        : `Expected only 'data'.`,
    );
  }
}

/**
 * Prisma accepts both a single object and an array everywhere a to-many nested
 * write is legal, and the singular form is the common one on a to-one.
 */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
