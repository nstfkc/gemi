import type { SqlDialect } from "../dialect";
import { RecordNotFoundError, UnsupportedQueryError } from "../errors";
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
  "disconnect",
  "delete",
  "update",
  "set",
  "updateMany",
  "deleteMany",
  "upsert",
]);

/**
 * Operands that only exist on a statement with a row to act on.
 *
 * Prisma refuses `disconnect` and `delete` under a `create` — *"Unknown
 * argument `disconnect`"* — and it is right to: there is nothing linked to a
 * row that does not exist yet. Refused here rather than accepted and made a
 * no-op, so a caller who wrote one on the wrong operation hears about it.
 */
const EXISTING_ROW_ONLY = new Set([
  "disconnect",
  "delete",
  "update",
  "set",
  "updateMany",
  "deleteMany",
  "upsert",
]);

/** Statements that insert a new row, so nothing is linked to it yet. */
const CREATE_ONLY_STATEMENTS = new Set(["create", "createMany"]);

/**
 * The operands still refused, and what each would take.
 *
 * Named individually rather than covered by one message, because "not
 * implemented" is much less useful than knowing whether the thing you reached
 * for is a rewrite or a wait. Each of these is a *write to rows that already
 * exist*, which is the line: everything supported writes new rows or repoints a
 * key, and none of it has to reason about what was there before.
 */
/**
 * Nothing, now — and that is the point of leaving the table here.
 *
 * Every entry it once held described machinery that turned out to exist one
 * layer down: five of them said a pass was missing that the child's own
 * `$exec` already runs, and the sixth — `upsert`'s — said the branch could not
 * be decided from inside a nested step, when `connectOrCreate` had been
 * deciding one the same way since #94.
 *
 * Kept rather than deleted because the next operand added here should have to
 * write its reason down, and because a reason naming *machinery* is checkable
 * where one naming a *principle* is not. That distinction is the only thing
 * that made six stale entries findable.
 */
const REFUSED: Record<string, string> = {};

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
  const link = resolveLink(schema, child, relation, operation);

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
        `Only ${[...SUPPORTED].sort().join(", ")} are implemented.` +
          (why ? ` '${key}' is not: ${why}` : ""),
      );
    }

    // `create` has no row to disconnect from, and Prisma does not offer these
    // there either — it reports them as an unknown argument.
    if (EXISTING_ROW_ONLY.has(key) && CREATE_ONLY_STATEMENTS.has(operation)) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.${key}`,
        schema.name,
        operation,
        `'${key}' acts on rows already linked to this one, and a '${operation}' ` +
          `has none yet — Prisma refuses it here too. Use it on an 'update'.`,
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
  /**
   * `disconnect: true` on a to-one — clear the foreign key this row holds.
   *
   * No step at all: the key lives on this row, so it is one more bound column
   * set to `null`, exactly as `connect`'s direct form is one bound column set
   * to a value. Nothing on the child is read or written, which is why there is
   * no scoping question on this side — the row being changed is the one the
   * statement already names.
   *
   * `delete` has no meaning here for the same reason it has no `createMany`:
   * this side is a to-one, and deleting the far row through a `data` key would
   * be deleting a row the statement is not about. Prisma does offer it; it is
   * refused rather than guessed, because a `delete` that fires as a side effect
   * of an unrelated update is the kind of thing to implement deliberately.
   */
  if (key === "disconnect") {
    assertDisconnectable(schema, relation, fkField, operation);

    if (operand !== true) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.disconnect`,
        schema.name,
        operation,
        `'${relation.name}' is a to-one, so there is one row to clear and ` +
          `nothing to name. Prisma takes 'true' here.`,
      );
    }

    out.contributions.push({ field: fkField, value: () => null });
    return;
  }

  if (key === "delete") {
    throw new UnsupportedQueryError(
      `data.${relation.name}.delete`,
      schema.name,
      operation,
      `'${relation.name}' is a to-one whose foreign key lives on this row, so ` +
        `deleting through it would remove a row this statement is not about. ` +
        `Delete it directly, or 'disconnect' it first.`,
    );
  }

  /**
   * `update` through a to-one — this row holds the key, so the row being
   * written is the one it points at.
   *
   * Prisma accepts both spellings, measured: `update: { name: "x" }` and
   * `update: { data: { name: "x" } }`. The second is the documented one and the
   * first is what people write; accepting only one would refuse a legal query.
   *
   * An `after` step rather than a `before` one, and it needs the foreign key in
   * the statement's `RETURNING` — the far row is identified by *this* row's
   * column, whose current value the arguments do not carry. That is why
   * `keyFields` gains it here, where the other owning-side operands need
   * nothing returned at all.
   */
  if (key === "update") {
    out.keyFields.push(fkField);

    out.after.push({
      relation: relation.name,
      operation: "update",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const linked = parent[fkField];
        if (linked === null || linked === undefined) {
          // The same error as the foreign side's miss, and for the same reason
          // — this is one condition with two spellings, not two conditions.
          // Measured rather than inferred: Prisma answers P2025 here too,
          // *"depends on one or more records that were required but not
          // found"*, which `failureKind` maps to `notFound`.
          //
          // `UnsupportedQueryError` was wrong twice over. It classifies as
          // `other`, so the differential harness would have called it agreement
          // with a Prisma refusal of a different kind — and it prefixes "does
          // not support … yet", which reports a fully-implemented operation as
          // unimplemented because a row is missing. That vocabulary has been
          // corrected once each on #82 and #88.
          throw new RecordNotFoundError(relation.model, "update");
        }

        const operandAt = at(args);
        const data =
          operandAt !== null &&
          typeof operandAt === "object" &&
          "data" in operandAt
            ? (operandAt as Record<string, unknown>).data
            : operandAt;

        await executor.exec(
          relation.model,
          "updateMany",
          { where: { [referenced]: linked }, data },
          // NOT pre-scoped: the child's own policies decide whether this row is
          // reachable and whether the payload is allowed to write what it
          // names — its `onUpdate` and its scope-escape guard.
          false,
        );
      },
    });
    return;
  }

  /**
   * `upsert` through a to-one, refused **by name**.
   *
   * The far row is identified by *this* row's foreign key, so an absent one
   * means creating the far row and then writing back to a parent that has
   * already been inserted — a shape no other operand here needs, and the
   * reason this side is not implemented.
   *
   * Named rather than left to fall through, which is what it did: with no
   * branch of its own it reached the `connect` handling below and reported
   * `'where' yet (Organization.update.organization.connect)` — a different
   * operand, a different model, and a claim that `{ id: 1 }` is not a unique
   * field when it is. The real failure was that a `{ where, create, update }`
   * operand was being read as a connect key.
   *
   * That is the shape #85 was filed for and #101 fixed on its own path: a
   * refusal that misnames its origin sends the reader to a query they did not
   * write.
   */
  /**
   * The list operands, refused by name on a to-one.
   *
   * `set`, `updateMany` and `deleteMany` describe *many* rows, and this side
   * has one by construction — Prisma does not offer them here either. They were
   * in `SUPPORTED` with no branch on this side, so they fell through to the
   * `connect` handling below and reported `connect` back to a caller who wrote
   * something else. Same fall-through as `upsert`'s, found by the same test.
   */
  if (key === "set" || key === "updateMany" || key === "deleteMany") {
    throw new UnsupportedQueryError(
      `data.${relation.name}.${key}`,
      schema.name,
      operation,
      `'${relation.name}' is a to-one: this row holds a single foreign key, so ` +
        `there is no set of rows for '${key}' to act on. Prisma does not ` +
        `accept it here either. Use 'connect', 'disconnect' or 'update'.`,
    );
  }

  if (key === "upsert") {
    throw new UnsupportedQueryError(
      `data.${relation.name}.upsert`,
      schema.name,
      operation,
      `'${relation.name}' is a to-one, and this row holds its foreign key — ` +
        `so an absent far row would have to be created and then written back ` +
        `to a ${schema.name} that has already been inserted. That is not ` +
        `implemented. Upsert the ${relation.model} directly, then 'connect' ` +
        `it.`,
    );
  }

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
  matchUniqueKey(child, operand, {
    model: schema.name,
    operation,
    argument: `data.${relation.name}.connect`,
  });

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

  /**
   * `disconnect` and `delete` on this side both act on rows the caller named by
   * unique key — which is what makes them expressible at all, and what puts
   * them on the supported side of this file's line.
   *
   * They differ on a row that is *not* linked to this parent, and the
   * difference is Prisma's, measured rather than chosen:
   *
   *     disconnect a row linked elsewhere  ->  succeeds, changes nothing
   *     delete     a row linked elsewhere  ->  raises "are not connected"
   *
   * So both filter by the parent key as well as the caller's key, and only
   * `delete` treats a miss as an error. That filter is doing two jobs at once:
   * it reproduces Prisma's semantics, and it is what stops either operand from
   * reaching a row belonging to a different parent.
   *
   * **Scoping comes from the child's own operations**, as everywhere else here:
   * `updateMany` and `delete` go through the child's `$exec` un-pre-scoped, so
   * a row the child's policies hide is not reachable. For `delete` that means a
   * hidden row reports "not connected" rather than "denied" — the same answer
   * as a row that genuinely is not linked, which is the conservative one.
   */
  /**
   * `update: { where, data }` — the caller's columns, written to a row they
   * named by unique key.
   *
   * **The pass this was refused for turns out to exist**, one layer down. The
   * `REFUSED` entry said it "needs its own scoping pass" for `onUpdate` and the
   * scope-escape guard; both of those live in `applyPolicies`, which the
   * child's own `$exec` runs because this step is not pre-scoped. Verified
   * rather than assumed:
   *
   *     another tenant's row  ->  { count: 0 }        the child's scope
   *     caller names a scoped column  ->  ScopeEscapeError
   *
   * So the refusal was describing a gap in the wrong place. What `update`
   * genuinely needs beyond `disconnect` is nothing: the parent-key filter that
   * keeps it off another parent's row is the same one, and the payload is the
   * child's business.
   *
   * `updateMany` stays refused because it names a *predicate* rather than a
   * row, which is the half of the line this file draws that has not moved.
   */
  /**
   * `set` — replace the whole set with the named rows.
   *
   * The one supported operand that acts on rows the **call** did not name: it
   * disconnects whatever is currently linked before connecting what was asked
   * for. That is the half of this file's line it appears to fail, and #83
   * already answered how — its implicit many-to-many `set` had the identical
   * problem and the fix was to give the disconnect a *lookup*: read the linked
   * rows through the child's own `findMany`, and clear only the ones the
   * caller can see.
   *
   * So `set` means **"replace the set I can see"**. With no policy on the child
   * every row is visible and it is Prisma's `set` exactly; with one, a row the
   * caller cannot see stays attached rather than being silently detached —
   * which is the same choice `disconnect` makes one operand over, and the
   * opposite of what an unscoped delete would do.
   *
   * Three measured details that are not obvious from the name:
   *
   *   set [one of two]   the unnamed row's key becomes null, the named stays
   *   set []             every linked row is detached
   *   set [another parent's row]   it is repointed here, as `connect` does
   *   set [a row that does not exist]   silently ignored — no error
   *
   * The last is why the connect half is an `updateMany` rather than the
   * `update` a nested `connect` uses: Prisma does not raise here, and matching
   * that means not raising either.
   *
   * Both halves write the child's foreign key, so `set` inherits #98 exactly as
   * `connect` does: a child whose policy scopes on that column is refused by
   * the scope-escape guard, because it cannot tell a column the ORM wrote from
   * one the caller did. #99 fixes that for every relation operand at once, and
   * this needs no change when it lands.
   */
  /**
   * `updateMany` and `deleteMany` — a **filter**, applied to this parent's rows.
   *
   * These were the last two refused on the "names a predicate rather than a
   * row" reading of #94's line, and that reading was too strong. What the line
   * is really asking is whether there is a `where` the child's scope can be
   * `AND`ed into — and a predicate is exactly that. Both operations are in
   * `SCOPABLE`, so routing them through the child's own `$exec` gives the scope
   * on which rows match, and `updateMany` gets `onUpdate` and the scope-escape
   * guard over its payload, the same way #101's `update` does.
   *
   * The parent key goes into the filter for the same reason it does everywhere
   * else here: Prisma applies these to *this* parent's children only, verified
   * before implementing, and without it a `deleteMany: {}` would empty the
   * table.
   *
   * **The two operands are shaped differently**, which is easy to get backwards:
   *
   *     updateMany: { where: { … }, data: { … } }
   *     deleteMany: { … }                            the filter directly
   *
   * `upsert` stays refused, and its reason is the one that has not moved: it
   * needs to know which branch ran from inside a nested step, which neither
   * half of it provides.
   */
  /**
   * `upsert` — find by a unique key **within this parent's rows**, update it or
   * create it.
   *
   * Its refusal said it *"needs a third thing neither half has: deciding which
   * branch ran, from inside a nested step"*. It does not: the lookup decides
   * the branch, exactly as `connectOrCreate` has decided one since #94. That is
   * the sixth `REFUSED` reason in this series to describe machinery that was
   * already there.
   *
   * **Scoped to this parent, which is Prisma's own semantics and not an
   * embellishment** — measured, because it is the detail that decides what the
   * operand means:
   *
   *   upsert a row belonging to another parent
   *     ->  Unique constraint failed on the fields: (`publicId`)
   *
   * Prisma looks only among *this* parent's children, does not find it, takes
   * the create branch, and collides. So the conjunction that keeps every other
   * filter operand on this parent is what produces the right branch here, not
   * merely what keeps it safe.
   */
  if (key === "upsert") {
    assertUpsertOperand(schema, relation, child, operand, operation);

    out.after.push({
      relation: relation.name,
      operation: "upsert",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        for (const entry of listOf(at(args)) as Record<string, unknown>[]) {
          const where = conjoin(entry.where, {
            [childField]: parent[parentField],
          });

          const hit = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: { [childField]: true } },
            false,
          )) as Record<string, unknown> | null;

          if (hit) {
            await executor.exec(
              relation.model,
              "updateMany",
              { where, data: entry.update },
              // NOT pre-scoped: the child's `onUpdate` and scope-escape guard
              // judge the payload, as they do for a nested `update`.
              false,
            );
            continue;
          }

          await executor.exec(
            relation.model,
            "create",
            {
              // The foreign key is ours, as it is for every create here.
              data: {
                ...(entry.create as object),
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

  if (key === "updateMany" || key === "deleteMany") {
    const updating = key === "updateMany";
    assertManyOperand(schema, relation, operand, key, operation);

    out.after.push({
      relation: relation.name,
      operation: key,
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const operandAt = at(args) as Record<string, unknown>;
        const filter = updating ? operandAt?.where : operandAt;

        // **`AND`, not a spread.** A spread lets the parent key *overwrite* a
        // caller filter naming the same column: `deleteMany: { userId: 9 }` on
        // this parent's relation became `{ userId: <this parent> }`, so a query
        // asking for children belonging to somebody else deleted every one of
        // this parent's instead. Silent, and in the deleting direction.
        //
        // Prisma conjoins — measured, because the whole question is what it
        // does rather than what is tidy:
        //
        //   deleteMany { userId: <other> }  ->  nothing deleted
        //
        // Conjoining also keeps the parent restriction *unforgeable* while
        // letting the caller's predicate narrow, which is exactly what
        // `withScope` does for a policy fragment and for the same reason.
        const where = conjoin(filter, { [childField]: parent[parentField] });

        await executor.exec(
          relation.model,
          key,
          updating ? { where, data: operandAt?.data } : { where },
          // NOT pre-scoped. The child's scope narrows which rows match, and for
          // `updateMany` its `onUpdate` and scope-escape guard judge the
          // payload — which is the whole reason these are expressible.
          false,
        );
      },
    });
    return;
  }

  if (key === "set") {
    assertNamedRows(schema, relation, child, operand, "set", operation);
    assertDisconnectable(child, relation, childField, operation);

    out.after.push({
      relation: relation.name,
      operation: "set",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const parentKey = parent[parentField];

        // Everything currently linked *that this caller can see*. Not
        // pre-scoped, which is the whole mechanism: the child's own policies
        // decide what "currently linked" means for this caller.
        const linked = (await executor.exec(
          relation.model,
          "findMany",
          { where: { [childField]: parentKey }, select: { [childField]: true } },
          false,
        )) as Record<string, unknown>[];

        if (linked.length > 0) {
          await executor.exec(
            relation.model,
            "updateMany",
            { where: { [childField]: parentKey }, data: { [childField]: null } },
            false,
          );
        }

        for (const entry of listOf(at(args))) {
          await executor.exec(
            relation.model,
            "updateMany",
            { where: entry as object, data: { [childField]: parentKey } },
            false,
          );
        }
      },
    });
    return;
  }

  if (key === "update") {
    assertNamedUpdates(schema, relation, child, operand, operation);

    out.after.push({
      relation: relation.name,
      operation: "update",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const list = listOf(at(args));

        for (let index = 0; index < list.length; index++) {
          const entry = list[index] as Record<string, unknown>;
          // The caller's key *and* the link, so an `update` cannot reach a row
          // attached to a different parent — the same filter `delete` uses,
          // and it does the same two jobs. `AND` rather than a spread for the
          // reason `updateMany` documents: a key naming the foreign column
          // itself would otherwise be overwritten rather than honoured.
          const where = conjoin(entry.where, {
            [childField]: parent[parentField],
          });

          const found = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: { [childField]: true } },
            false,
          )) as Record<string, unknown> | null;

          if (!found) {
            // `RecordNotFoundError`, not `UnsupportedQueryError`: nothing here
            // is unsupported, the row simply is not there. Prisma agrees —
            // P2025, *"depends on one or more records that were required but
            // not found"* — and the differential harness compares the failure
            // *kind* precisely so a refusal cannot pass as agreement with a
            // miss. This one was `other` against Prisma's `notFound` until the
            // harness said so.
            throw new RecordNotFoundError(relation.model, "update");
          }

          await executor.exec(
            relation.model,
            "updateMany",
            { where, data: entry.data },
            // NOT pre-scoped, and this is the whole reason `update` is
            // expressible: the child's own policies run over `data` — its
            // `onUpdate` defaults, its scope-escape guard refuses a caller
            // naming a scoped column — because they have not run yet.
            false,
          );
        }
      },
    });
    return;
  }

  if (key === "disconnect" || key === "delete") {
    const deleting = key === "delete";
    if (!deleting) assertDisconnectable(child, relation, childField, operation);

    assertNamedRows(schema, relation, child, operand, key, operation);

    out.after.push({
      relation: relation.name,
      operation: key,
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const list = listOf(at(args));

        for (let index = 0; index < list.length; index++) {
          // The caller's key *and* the link, so neither operand can reach a row
          // attached to a different parent. `AND` rather than a spread — see
          // `updateMany`.
          const where = conjoin(list[index], {
            [childField]: parent[parentField],
          });

          if (!deleting) {
            await executor.exec(
              relation.model,
              "updateMany",
              { where, data: { [childField]: null } },
              // NOT pre-scoped: clearing a foreign key is a write to the child,
              // so the child's scope decides which rows are reachable.
              false,
            );
            continue;
          }

          const found = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: { [childField]: true } },
            false,
          )) as Record<string, unknown> | null;

          if (!found) {
            throw new UnsupportedQueryError(
              `data.${relation.name}.delete`,
              schema.name,
              operation,
              `the row named by ${JSON.stringify(list[index])} is not ` +
                `connected to this ${schema.name}. Prisma raises here too, ` +
                `rather than deleting a row belonging to somebody else.`,
            );
          }

          await executor.exec(
            relation.model,
            "deleteMany",
            { where },
            // NOT pre-scoped, for the reason above — and `deleteMany` rather
            // than `delete` because the `where` carries the link as well as the
            // unique key, which `delete` refuses as a non-unique target.
            false,
          );
        }
      },
    });
    return;
  }

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
  //
  // Checked here rather than in the step below, for the reason `assertNamedRows`
  // gives: the step runs after the parent row is written, so a key the child
  // does not declare unwinds an insert that should never have happened. The
  // owning side has always checked its `connect` at plan time; this side had
  // not, which made the same operand answer differently depending on which
  // table the foreign key is on (#110).
  assertNamedRows(schema, relation, child, operand, key, operation);

  out.after.push({
    relation: relation.name,
    operation: "connect",
    async run(args, _context, executor, rows) {
      const parent = rows[0];
      if (!parent) return;

      for (const item of listOf(at(args))) {
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

/**
 * What an implicit many-to-many accepts, and how it differs from
 * {@link SUPPORTED} — which is the ordinary-relation set.
 *
 * **The two must be reconciled deliberately.** `planOne` checks `link.join`
 * first and returns, so this path never consults `SUPPORTED` at all: the sets
 * drift without anything failing to compile and without a test noticing, and
 * they did — #83 landed this one while four branches were adding to the other,
 * none of which could see it from inside itself.
 *
 * **The gaps are unimplemented, not by design, and that is measured rather than
 * reasoned.** An earlier version of this comment claimed the split was "the
 * link versus the far row" — operands about the pair work here, operands about
 * the far row do not. It is a tidy rule and it is wrong. Prisma offers five of
 * the six through an implicit m-n:
 *
 *     update           OK   the far row is updated
 *     delete           OK   the far row is deleted, not just the pair
 *     deleteMany       OK
 *     updateMany       OK
 *     connectOrCreate  OK
 *     createMany       Unknown argument — Prisma refuses it here too
 *
 * So `delete` through a join table really does mean deleting the far row, which
 * is the opposite of what that rule predicted. Only `createMany` is a genuine
 * refusal, and it is Prisma's rather than ours.
 *
 * `connectOrCreate` is implemented here because #83 already had both of its
 * halves — `connect` inserts a pair for an existing row, `create` writes the
 * row and its pair — so it is those two selected by a lookup. The remaining
 * four reach the far row *through* the pairs, which is a second hop this path
 * does not have yet; {@link JOIN_TABLE_REFUSED} says so in those terms rather
 * than inventing a principle.
 *
 * `set` is the one operand with **two implementations** — this file's
 * join-table version from #83 and the ordinary-relation one — and they agree
 * because both were reasoned to "replace the set I can see" independently, not
 * because they share anything. Worth knowing when either is changed.
 */
const JOIN_TABLE_SUPPORTED = new Set([
  "connect",
  "connectOrCreate",
  "disconnect",
  "set",
  "create",
]);

/**
 * Why each ordinary-relation operand is not offered through a join table.
 *
 * Same shape as {@link REFUSED}, and for the same reason: "not implemented" is
 * much less useful than knowing whether the thing you reached for is a rewrite
 * or a wait — and here most of them are neither, they are a different operation
 * wearing the same name.
 */
const JOIN_TABLE_REFUSED: Record<string, string> = {
  // Prisma's own refusal, not this ORM's — the one entry here that is a
  // decision rather than a gap, and it is not gemi's decision.
  createMany:
    `Prisma does not offer 'createMany' through an implicit many-to-many ` +
    `either — it reports it as an unknown argument. Use 'create', which writes ` +
    `the row and its pair.`,
  // The four that reach the far row through the pairs. Prisma implements all
  // of them; this path does not have the second hop yet.
  update:
    `Reaching the far row means reading the pairs first, which this path does ` +
    `not do yet. Update the related model directly, filtered by its own key.`,
  updateMany:
    `As 'update': it needs the pairs read before the far rows can be matched.`,
  delete:
    `It deletes the far row rather than the pair — Prisma does this through a ` +
    `join table too — and reaching it means reading the pairs first, which ` +
    `this path does not do yet. Use 'disconnect' to remove the link, or delete ` +
    `the row through its own model.`,
  deleteMany:
    `As 'delete': the far rows have to be found through the pairs first.`,
};

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
  if (key === "connectOrCreate") {
    assertConnectOrCreateOperand(
      schema,
      relation,
      child,
      operand,
      operation,
      relation.kind === "many",
    );
  }

  if (!JOIN_TABLE_SUPPORTED.has(key)) {
    const why = JOIN_TABLE_REFUSED[key];
    if (why) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.${key}`,
        schema.name,
        operation,
        `'${relation.name}' is an implicit many-to-many, and '${key}' means ` +
          `something different through a join table. ${why}`,
      );
    }

    throw new UnsupportedQueryError(
      `data.${relation.name}.${key}`,
      schema.name,
      operation,
      `'${relation.name}' is an implicit many-to-many. Only ` +
        `${[...JOIN_TABLE_SUPPORTED].sort().join(", ")} are implemented ` +
        `through its join table.`,
    );
  }

  // `connect`, `disconnect` and `set` name existing rows by a unique key, and
  // the step below resolves them one at a time — after the parent row exists,
  // since a pair needs both ends. That made a key the child does not declare
  // refuse from mid-transaction, while the *same* operand on an ordinary
  // relation refuses from the compiler (#110). `create` names no existing row
  // and `connectOrCreate` is checked above, so those two are not this.
  if (key === "connect" || key === "disconnect" || key === "set") {
    assertNamedRows(schema, relation, child, operand, key, operation);
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

        /**
         * `connectOrCreate` is the two branches above selected by a lookup, so
         * it needed no new machinery here — which is why it is the one of the
         * five missing operands this change adds.
         *
         * `findUnique`, not the `findUniqueOrThrow` the `connect` path below
         * uses: a miss is the *other branch* here rather than an error. And a
         * scoped-away hit therefore takes the create branch, which is the same
         * answer the ordinary-relation `connectOrCreate` gives and closes the
         * same probe — `connect` raising where this succeeds would together
         * confirm a row the caller cannot see.
         */
        if (key === "connectOrCreate") {
          // The `where` was validated at plan time by
          // `assertConnectOrCreateOperand`, which the branch at the top of this
          // function runs for both relation kinds.
          const entry = item as Record<string, unknown>;

          const hit = (await executor.exec(
            relation.model,
            "findUnique",
            { where: entry.where, select: { [childField]: true } },
            false,
          )) as Record<string, unknown> | null;

          if (hit) {
            childKeys.push(hit[childField]);
            continue;
          }

          const made = (await executor.exec(
            relation.model,
            "create",
            { data: entry.create, select: { [childField]: true } },
            false,
          )) as Record<string, unknown> | null;
          if (made) childKeys.push(made[childField]);
          continue;
        }

        // `connect`, `disconnect` and `set` all name existing rows by a unique
        // key — checked at plan time above. Resolved through the child's own
        // `$exec`, so its policies decide which rows exist — otherwise a
        // connect by any unique key reaches every tenant's.
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
 * `upsert`'s operand: `{ where, create, update }`, or a list of them.
 *
 * All three are required — the lookup, and one payload per branch. Checked at
 * plan time like every other operand here, so a missing key fails when the
 * query compiles rather than after the parent row is written.
 */
function assertUpsertOperand(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  operation: string,
): void {
  const at = `data.${relation.name}.upsert`;
  const entries = (Array.isArray(operand) ? operand : [operand]) as unknown[];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        `Expected an object with 'where', 'create' and 'update'.`,
      );
    }

    const record = entry as Record<string, unknown>;
    for (const required of ["where", "create", "update"] as const) {
      if (record[required] === undefined) {
        throw new UnsupportedQueryError(
          at,
          schema.name,
          operation,
          `Expected a '${required}' key — 'upsert' names the row to look for, ` +
            `what to write if it is there, and what to write if it is not.`,
        );
      }
    }

    matchUniqueKey(child, record.where, {
      model: schema.name,
      operation,
      argument: `data.${relation.name}.upsert.where`,
    });
  }
}

/**
 * The caller's filter and the parent restriction, as a conjunction.
 *
 * Never a spread. A spread merges by *key*, so a caller naming the foreign key
 * column silently replaces the restriction that keeps the operand on this
 * parent's rows — and the failure is a wider write, not an error. `AND` cannot
 * be overwritten by any key the caller chooses, and it still lets their
 * predicate narrow, which is the property `withScope` relies on for policy
 * fragments.
 *
 * An empty or absent filter contributes nothing, so the common case is the
 * restriction alone rather than `AND` of one thing.
 */
function conjoin(
  filter: unknown,
  restriction: Record<string, unknown>,
): Record<string, unknown> {
  if (
    filter === undefined ||
    filter === null ||
    typeof filter !== "object" ||
    Array.isArray(filter) ||
    Object.keys(filter as object).length === 0
  ) {
    return restriction;
  }
  return { AND: [filter as object, restriction] };
}

/**
 * The filter operands, which are shaped differently from each other.
 *
 * `updateMany` wraps its filter in `where` and carries a `data` beside it;
 * `deleteMany` *is* the filter. Checked at plan time, so a caller who wrote one
 * shape for the other hears about it before the parent row is written.
 *
 * `UnsupportedQueryError` here because that is what this branch has; both are
 * argument *validation* and belong in #103's `InvalidArgumentError`. They need
 * no edit when it lands — its conversion selects sites by whether their detail
 * already says what a valid value looks like, and these say `Expected an
 * object with 'where' and 'data'`.
 */
function assertManyOperand(
  schema: ModelSchema,
  relation: RelationSchema,
  operand: unknown,
  key: string,
  operation: string,
): void {
  const at = `data.${relation.name}.${key}`;

  if (typeof operand !== "object" || operand === null || Array.isArray(operand)) {
    throw new UnsupportedQueryError(
      at,
      schema.name,
      operation,
      key === "updateMany"
        ? `Expected an object with 'where' and 'data'.`
        : `Expected an object of filters — 'deleteMany' takes the filter ` +
          `directly, not wrapped in a 'where'.`,
    );
  }

  if (key !== "updateMany") return;

  const record = operand as Record<string, unknown>;
  for (const required of ["where", "data"] as const) {
    if (record[required] === undefined) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        `Expected a '${required}' key — 'updateMany' names which rows to ` +
          `write and what to write to them.`,
      );
    }
  }
}

/**
 * `update`'s operand: `{ where, data }`, or a list of them on a to-many.
 *
 * `data` is *not* inspected here — it is the child's, and the child's own
 * `$exec` validates it against the child's schema and policies. Checking it
 * against this model would be checking the wrong shape.
 */
function assertNamedUpdates(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  operation: string,
): Record<string, unknown>[] {
  const at = `data.${relation.name}.update`;
  const entries = (Array.isArray(operand) ? operand : [operand]) as unknown[];
  const out: Record<string, unknown>[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        `Expected an object with 'where' and 'data'.`,
      );
    }

    const record = entry as Record<string, unknown>;

    for (const required of ["where", "data"] as const) {
      if (record[required] === undefined) {
        throw new UnsupportedQueryError(
          at,
          schema.name,
          operation,
          `Expected a '${required}' key — 'update' names the row to write and ` +
            `the columns to write to it.`,
        );
      }
    }

    matchUniqueKey(child, record.where, {
      model: schema.name,
      operation,
      argument: `data.${relation.name}.update.where`,
    });
    out.push(record);
  }

  return out;
}

/**
 * The rows a `disconnect` / `delete` names, each by a unique key.
 *
 * Validated at plan time for the reason every operand here is: a refusal that
 * arrives mid-transaction has to unwind a parent row that should never have
 * been written.
 */
function assertNamedRows(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  key: string,
  operation: string,
): Record<string, unknown>[] {
  const at = `data.${relation.name}.${key}`;
  const entries = (Array.isArray(operand) ? operand : [operand]) as unknown[];
  const out: Record<string, unknown>[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        `Expected an object naming a unique field, or an array of them.`,
      );
    }
    matchUniqueKey(child, entry, {
      model: schema.name,
      operation,
      argument: `data.${relation.name}.${key}`,
    });
    out.push(entry as Record<string, unknown>);
  }

  return out;
}

/**
 * A `disconnect` clears a foreign key, so the column has to be nullable.
 *
 * Prisma refuses it on a required relation at the type level; here the schema
 * is the only thing that knows, so the refusal says which column and why rather
 * than letting the database report a not-null violation from inside a nested
 * step.
 */
function assertDisconnectable(
  owner: ModelSchema,
  relation: RelationSchema,
  fieldName: string,
  operation: string,
): void {
  const field = owner.fields[fieldName];
  if (field && field.nullable) return;

  throw new UnsupportedQueryError(
    `data.${relation.name}.disconnect`,
    owner.name,
    operation,
    `'${fieldName}' is required, so there is no value to leave behind — a ` +
      `disconnected row would have to be deleted or repointed instead. Prisma ` +
      `does not offer 'disconnect' on a required relation either.`,
  );
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

    matchUniqueKey(child, record.where, {
    model: schema.name,
    operation,
    argument: `data.${relation.name}.connectOrCreate.where`,
  });
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
