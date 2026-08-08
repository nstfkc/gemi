import {
  InvalidArgumentError,
  RecordNotFoundError,
  UnsupportedQueryError,
} from "../errors";
import type { SqlDialect } from "../dialect";
import type { ModelSchema, RelationSchema } from "../schema";
import type { Binder } from "./fragment";
import {
  type Link,
  type NestedWriteStep,
  type RelationExecutor,
  relatedSchema,
  resolveLink,
  singleFieldLink,
} from "./plan-relations";
import { matchUniqueKey, type RefusalOrigin } from "./unique";

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
    throw new InvalidArgumentError(
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
   * `disconnect` on a to-one whose key is on **this** row — the same three arms
   * the foreign side takes, through the same two helpers (#359).
   *
   * Prisma's operand here is `XWhereInput | boolean`, read off the generated
   * client and measured against it:
   *
   *     disconnect: true                    clears the link
   *     disconnect: false                   nothing happens, the link survives
   *     disconnect: {}                      clears it — the empty filter matches
   *     disconnect: { name: "Ada" }         clears it only if the linked row matches
   *     disconnect: { name: "Grace" }       no match, so nothing happens — and
   *                                         **silently**, not P2025
   *     disconnect: <filter>, nothing linked   silently nothing
   *
   * The silence in the last two is what makes the filter arm a *conditional*
   * detach rather than a guarded one: there is no miss to report, which is the
   * same asymmetry the foreign side measured between `disconnect` and `delete`
   * (M8c). So the arms differ only in what decides the value of one column.
   *
   * **The boolean is structural here, where the foreign side re-reads it at
   * bind time**, and that difference is forced rather than chosen. The foreign
   * side's operands are *statements* — `listOf(null)` is no statement — so a
   * plan handed the wrong boolean can still write nothing. This side's is a
   * *column in the SET list*: `false` emits no assignment and `true` emits one,
   * so the two spellings cannot share a statement text and no bind-time check
   * could rescue a cache hit that got it wrong. What makes that sound is
   * `shapeOfMember`'s guard (#358), which gives a `disconnect` boolean its own
   * plan key precisely because this decision is made once, at compile time.
   * Before it, a plan compiled from `true` served `false` and nulled a foreign
   * key on a call that asked for nothing.
   *
   * `delete` has no meaning here for the same reason it has no `createMany`:
   * this side is a to-one, and deleting the far row through a `data` key would
   * be deleting a row the statement is not about. Prisma does offer it; it is
   * refused rather than guessed, because a `delete` that fires as a side effect
   * of an unrelated update is the kind of thing to implement deliberately.
   */
  if (key === "disconnect") {
    // Before the arms, so a required foreign key is refused whichever one was
    // spelled — including `false`, which asks for nothing and still cannot be
    // written. Prisma agrees for a reason of its own: it leaves `disconnect`
    // out of the input type entirely when the relation is required, so
    // `disconnect: false` there is *"Unknown argument `disconnect`"* rather
    // than an accepted no-op. Measured on `SocialAccount.user`.
    assertDisconnectable(schema, relation, fkField, {
      model: schema.name,
      operation,
      argument: `data.${relation.name}.disconnect`,
    });

    // `true` -> `{}`, `false` -> `null`, a filter passes through: the same
    // translation and the same shape check the foreign side runs, reused rather
    // than restated so the two sides cannot answer one grammar differently
    // again — which is the defect #359 was filed for.
    const filter = toOneOperand(key, operand);
    assertToOneFilter(schema, relation, child, filter, key, operation);

    // `false` — no contribution and no step, so the operand contributes
    // *nothing at all*: a `data` carrying only this compiles to the read
    // `compileUpdate` emits for an empty assignment list, and the row comes
    // back with its link intact. That is Prisma's answer, and the reason the
    // differential asserts it by value: what this replaces was a write.
    if (filter === null || filter === undefined) return;

    /**
     * `true` — one bound column set to `null`, exactly as `connect`'s direct
     * form is one bound column set to a value. No step, nothing on the child
     * read or written, and so no scoping question: the row being changed is
     * the one the statement already names.
     */
    if (operand === true) {
      out.contributions.push({ field: fkField, value: () => null });
      return;
    }

    /**
     * A filter — detach only if the row this one points at matches it.
     *
     * Two reads, and neither is avoidable from this side. The condition is a
     * property of the *linked* row, and which row that is lives in a column of
     * the row being updated, which the arguments do not carry — so the parent
     * is read first and the child second. The far side needs neither: its
     * filter goes straight into the `where` of the `updateMany` that clears the
     * key, because there the key is on the row being filtered.
     *
     * **The child read goes through the child's own `$exec`, un-pre-scoped**,
     * which is what puts this operand on the supported side of this file's
     * line. A `disconnect` that acts on "whatever is there" has no lookup to
     * hang a scope on; this one has, so a child the caller's policies hide
     * reads as absent and the link survives — the same conservative answer
     * `set` gives, and the same one the foreign side's `disconnect` gives for a
     * hidden row.
     *
     * The parent read is **pre-scoped**: `args.where` is the effective `where`
     * this call already put through this model's policies, so re-applying them
     * would `AND` the same predicate twice. It reads one column of one row —
     * `update` matched its `where` against a unique key — inside the
     * transaction the nested steps already run in, so the value it returns is
     * the one the statement below is about to write over.
     */
    out.before.push({
      relation: relation.name,
      operation: "disconnect",
      async run(args, context, executor) {
        // Default to the value that is already there, so a filter that matches
        // nothing writes the column back unchanged. The contribution is in the
        // SET list either way — the statement's text cannot depend on a value
        // read at bind time — so "nothing happens" has to be spelled as an
        // assignment that changes nothing rather than as an absent one.
        context.resolved[fkField] = null;

        const parent = (await executor.exec(
          schema.name,
          "findFirst",
          { where: args?.where, select: { [fkField]: true } },
          true,
        )) as Record<string, unknown> | null;

        const linked = parent?.[fkField];
        // Nothing linked: no row for the filter to match, and Prisma is silent
        // about it. `null` is already what the column holds.
        if (linked === null || linked === undefined) return;

        context.resolved[fkField] = linked;

        const matched = await executor.exec(
          relation.model,
          "findFirst",
          {
            // `AND`, not a spread: a filter naming the referenced column itself
            // must narrow rather than replace the restriction that keeps this
            // on the linked row. Same rule as everywhere else here.
            where: conjoin(at(args), { [referenced]: linked }),
            select: { [referenced]: true },
          },
          false,
        );

        if (matched) context.resolved[fkField] = null;
      },
    });

    out.contributions.push({
      field: fkField,
      value: (_args, context) => context.resolved[fkField],
    });
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

    // The same check the foreign side runs, on the same operand grammar. Both
    // sides accept `{ where?, data }` and both must refuse an unknown key
    // inside it, or a misspelled `where` silently widens the write on whichever
    // side missed the check — the asymmetry #116 was filed about, arriving one
    // operand later.
    assertToOneWriteOperand(schema, relation, child, key, operand, operation);

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

        // `.data !== undefined` rather than `"data" in operandAt`, which is the
        // test {@link toOneOperand} makes and the one this used to disagree
        // with. `canonicalShape` drops an `undefined`-valued key, so `update:
        // {}` and `update: { data: undefined }` are one plan entry — and an
        // explicit `undefined` is the ordinary way a conditional write is
        // spelled, which is why `suppliedFields` skips it everywhere else.
        // Keying on presence sent `data: undefined` down to `updateMany` and
        // answered a no-op call with `updateMany requires 'data'`, on the side
        // this file cites as the precedent for the other one.
        const operandAt = at(args);
        const wrapped =
          operandAt !== null &&
          typeof operandAt === "object" &&
          (operandAt as Record<string, unknown>).data !== undefined;
        const record = operandAt as Record<string, unknown> | null;
        const data = wrapped ? record!.data : operandAt;

        // The caller's filter, conjoined with the link — so `update: { where,
        // data }` narrows *which* single row is written rather than being
        // decoration. Ignoring it was a silent wrong write: the operand
        // type-checks on both sides, the foreign side conjoins it and raises on
        // a miss, and this side renamed the linked row whether or not it
        // matched. Prisma answers P2025 for the non-matching case, which is
        // what the lookup below reproduces.
        //
        // The lookup only happens when a `where` is actually present, and that
        // is shape-stable — `canonicalShape` records a `where` key's presence —
        // so the common `update: { … }` spelling still costs one statement.
        const filter = wrapped ? record!.where : undefined;
        const where = conjoin(filter, { [referenced]: linked });

        if (filter !== undefined) {
          const found = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: { [referenced]: true } },
            false,
          )) as Record<string, unknown> | null;

          if (!found) throw new RecordNotFoundError(relation.model, "update");
        }

        await executor.exec(
          relation.model,
          "updateMany",
          { where, data },
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
    throw new InvalidArgumentError(
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
   * **A to-one whose key is on the child**, which this function otherwise plans
   * as though the child were a list.
   *
   * It had exactly one `kind` check — `createMany`'s, further down — because no
   * fixture had the shape, so nothing ever reached this side with `kind: "one"`
   * (#116). Everything else took the to-many spelling: `updateMany` and
   * `deleteMany` *compiled*, and `update` / `delete` / `upsert` were refused
   * for looking wrong rather than for being unimplemented here.
   *
   * Measured against the generated client rather than reasoned about. Prisma's
   * to-one nested input is
   *
   *     { create, connectOrCreate, upsert, disconnect, delete, connect, update }
   *
   * with no `createMany`, `set`, `updateMany` or `deleteMany` key at all — so
   * the first group below is refused for the same reason `planOwningSide`
   * refuses it, and says so in the same words.
   *
   * The rest of that input — `update`, `delete`, `upsert` — was refused here
   * too, for being spelled unlike the to-many form. It is implemented now, and
   * the implementation is a *translation* rather than three new bodies: see
   * {@link toOneOperand}.
   */
  if (relation.kind !== "many") {
    if (key === "set" || key === "updateMany" || key === "deleteMany") {
      throw new UnsupportedQueryError(
        `data.${relation.name}.${key}`,
        schema.name,
        operation,
        `'${relation.name}' is a to-one: there is a single ${child.name} row, ` +
          `so there is no set of rows for '${key}' to act on. Prisma does not ` +
          `offer it on a to-one either. Use 'connect', 'disconnect' or ` +
          `'update'.`,
      );
    }

    /**
     * **An array where the relation holds one row**, which compiled here and
     * wrote through it.
     *
     * Nothing below this point consults `kind`, so `create: [a, b]` inserted
     * two children, and `connect: [{ id: 1 }, { id: 2 }]` repointed *both* rows
     * through a relation that can hold one — the second silently winning. That
     * is a live divergence, not strictness: Prisma refuses all three, measured
     * off the generated client rather than reasoned from the docs.
     *
     *     connect: [{ id: 1 }, { id: 2 }]
     *       ->  PrismaClientValidationError, neither row repointed
     *     create: [{ bio: "a" }, { bio: "b" }]
     *       ->  "Expected ProfileCreateWithoutUserInput or
     *            ProfileUncheckedCreateWithoutUserInput, provided (Object, Object)"
     *
     * `PrismaClientValidationError` carries **no `code`** — it is an argument
     * refusal rather than a database one — which is why this is
     * `InvalidArgumentError` and not either `Unsupported*`: the argument is
     * supported and the value is wrong. So the message names the shape that
     * would work rather than announcing that arrays are unimplemented.
     *
     * Sound at plan time because array-ness is *in the plan key*: an array and
     * a single object are different structures to `canonicalShape`, so they can
     * never share a cache entry and this refusal cannot be decided on one
     * call's behalf by another's.
     */
    if (Array.isArray(operand)) {
      throw new InvalidArgumentError(
        `data.${relation.name}.${key}`,
        schema.name,
        operation,
        `'${relation.name}' is a to-one — ${child.name} holds the foreign key, ` +
          `so there is one row here at most. Expected a single object for ` +
          `'${key}', not an array of them. Prisma refuses the array too.`,
      );
    }

    /**
     * The three that were refused are a **spelling** difference, not missing
     * machinery. `conjoin` returns the parent restriction alone when the
     * caller's filter is absent or `{}`, and `listOf(null)` is `[]` — so a
     * to-one is a to-many of one, and the bodies below already do the work
     * once the operand is written the way they read.
     *
     * **Rebinding `at` — translating at *bind* time and not only while the plan
     * is compiled — is load-bearing for exactly one branch, and that is the
     * correctness argument for this whole design.** Every other distinction the
     * table draws is *structural*, so it may safely be decided once when the
     * plan is built: `{ data }` against `{ where, data }`, a `where` present
     * against absent, an array against an object — `canonicalShape` records all
     * of those, so two calls that differ there are already two plans. The
     * boolean is the one that is not. `delete: true` and `delete: false` are
     * the same shape to everything except the guard `shapeOfMember` carries for
     * exactly this, and a plan key is a cache rather than a contract. Reading
     * the boolean inside `at` means the step consults the *call's* value on
     * every execution, so a plan handed the wrong one still writes nothing —
     * `listOf(null)` is `[]`. Belt and braces on purpose: the owning side's
     * version of the same collision was a silent wrong write for its whole
     * life, precisely because its `true`/`false` decision was made once at
     * compile time and never revisited.
     */
    // Checked *before* the rewrite, because the rewrite is lossy by
    // construction: it rebuilds the operand from the keys it knows, so a key it
    // does not know is gone by the time anything downstream could refuse it.
    assertToOneWriteOperand(schema, relation, child, key, operand, operation);

    const spelled = at;
    at = (args: any) => toOneOperand(key, spelled(args));
    operand = toOneOperand(key, operand);
  }

  /**
   * `disconnect` and `delete` on this side act on rows the caller named by
   * unique key — which is what makes them expressible at all, and what puts
   * them on the supported side of this file's line.
   *
   * **On a to-one the caller names a *filter*, or nothing at all**, and that
   * does not weaken the line: the row is still identified, by the parent's own
   * key, which is the strongest naming available. `assertToOneFilter` is what
   * replaces the unique-key match there, and the filter only narrows.
   *
   * They differ on a row that is *not* linked to this parent, and the
   * difference is Prisma's, measured rather than chosen — on both kinds, since
   * the second pair is the same asymmetry read through the to-one spelling:
   *
   *     disconnect a row linked elsewhere  ->  succeeds, changes nothing
   *     delete     a row linked elsewhere  ->  raises "are not connected"
   *     disconnect: true, nothing linked   ->  succeeds, changes nothing
   *     delete: true,     nothing linked   ->  P2025
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
   *
   * **The clearing half stopped inheriting it and the linking half must not,
   * which is measured rather than tidy.** `clearLinks` names the column as the
   * ORM's, because a nested `create` on an occupied to-one needs the same clear
   * and would otherwise be refused for a write nobody made. Naming it on the
   * *link* too makes `set` succeed — and succeed wrongly: the clear nulls the
   * key, which puts the row outside the very scope (`{ folderId: 2 }`) the link
   * then has to select it by, so the row is detached and never re-attached. A
   * silent half-write in place of a loud refusal. Left refused until #99 can
   * answer the scope as well as the guard.
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
  /**
   * **The to-one reaches this same body, and it needed nothing added.** Its
   * `where` is optional — `ProfileUpsertWithoutUserInput` is
   * `{ update, create, where? }` — so `conjoin(undefined, link)` is the link
   * alone and the lookup finds the single connected child. Measured on both
   * branches:
   *
   *   no child, no `where`      ->  the create branch runs *and stamps the
   *                                 foreign key* — Profile { bio: "created",
   *                                 userId: 1 }
   *   child present, no `where` ->  the update branch runs against it
   *   child present, `where` matching nothing
   *                             ->  the create branch runs and collides:
   *                                 P2002, "Unique constraint failed on the
   *                                 fields: (`userId`)"
   *
   * The third is the note above transposed to the foreign side, and it is the
   * one to-one nested-write miss that is *not* P2025. It is left to happen
   * rather than pre-empted: the create is what Prisma runs, so surfacing
   * `UniqueConstraintError` from it is agreement, where refusing early would be
   * a different error for the same query.
   */
  if (key === "upsert") {
    assertUpsertOperand(
      schema,
      relation,
      child,
      operand,
      operation,
      relation.kind === "many",
    );

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
    assertDisconnectable(child, relation, childField, {
      model: schema.name,
      operation,
      argument: `data.${relation.name}.set`,
    });

    out.after.push({
      relation: relation.name,
      operation: "set",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        if (!parent) return;

        const parentKey = parent[parentField];

        await clearLinks(relation, childField, parentKey, executor);

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
    assertNamedUpdates(
      schema,
      relation,
      child,
      operand,
      operation,
      relation.kind === "many",
    );

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
            //
            // **Fatal on the to-one too, which was the open question and is
            // now measured.** The worry was that a to-one `update` naming a
            // non-matching `where` might be a no-op there, which would have
            // made this branch wrong for one `kind` and forced the two apart.
            // It does not: with a child present and `where: { bio: "nope" }`
            // Prisma raises P2025 — *"No 'Profile' record was found for a
            // nested update on one-to-one relation 'ProfileToUser'"* — with
            // wording identical to the no-child case, and the parent's own
            // assignments roll back with it. Absent and not-matching are one
            // condition to Prisma, so they stay one error here.
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
    if (!deleting) {
      // Before any boolean normalisation would matter, and it has to be:
      // Prisma leaves `disconnect` out of the input type *entirely* when the
      // child's foreign key is required, so even `disconnect: false` is
      // rejected there — *"Unknown argument `disconnect`. Did you mean
      // `connect`?"*, with the available options listed as create /
      // connectOrCreate / upsert / connect / update. The refusal is on the
      // **key**, not on the value, and this one already reads only the schema.
      assertDisconnectable(child, relation, childField, {
        model: schema.name,
        operation,
        argument: `data.${relation.name}.disconnect`,
      });
    }

    /**
     * **A to-one names a filter here; a to-many names rows by unique key.**
     *
     * `ProfileUpdateOneWithoutUserNestedInput` spells both operands
     * `ProfileWhereInput | boolean`, and it means it — measured:
     * `delete: { bio: "seed" }` is accepted with no `@unique` anywhere near
     * `bio`, and it deletes the connected row. Running `matchUniqueKey` on this
     * path would therefore refuse a query Prisma answers, which is why
     * `assertToOneFilter` replaces `assertNamedRows` rather than joining it.
     */
    if (relation.kind === "many") {
      assertNamedRows(schema, relation, child, operand, key, operation);
    } else {
      assertToOneFilter(schema, relation, child, operand, key, operation);
    }

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
              // ...but the column is *ours*: the caller wrote `disconnect: { id }`
              // and the ORM chose to null the key. Without this a child scoped
              // on its own foreign key is refused for a write it never made —
              // the same case as `connect`, see #98 and `ormAuthoredFields`.
              [childField],
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
            /**
             * **Two misses, two errors — and this is the third time this exact
             * mis-classification has had to be corrected** (see the notes at
             * `planOwningSide`'s `update` and at this file's own `update`
             * miss).
             *
             * On a to-one the caller named no row: `delete: true` means the
             * connected child, and there is either one or there is not.
             * Reporting *"the row named by `true` is not connected"* would be
             * nonsense to read, and worse it classifies as `other` where Prisma
             * answers P2025 — *"No 'Profile' record was found for a nested
             * delete on one-to-one relation 'ProfileToUser'"* — so the
             * differential harness would score a refusal as agreement with a
             * miss. Measured on both spellings: `delete: true` with no child
             * and `delete: { bio: "nope" }` with a child present give the same
             * P2025, so one error covers both.
             *
             * **`disconnect` does not come through here at all, and that
             * asymmetry is Prisma's.** A disconnect that matches nothing —
             * `disconnect: true` with no child, or a filter matching none — is
             * a *silent no-op* that still returns the parent, measured both
             * ways. The two operands share this body but must not share their
             * miss handling, which is why only `deleting` reaches this branch.
             */
            if (relation.kind !== "many") {
              throw new RecordNotFoundError(relation.model, "delete");
            }

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

  /**
   * `create` — insert the child, with this row's key stamped onto it.
   *
   * **On a to-one the new row has to displace the old one, and Prisma
   * *detaches* the incumbent rather than deleting it** (#360). Measured, with
   * user 1 already carrying a profile:
   *
   *     user.update({ data: { profile: { create: { bio: "second" } } } })
   *       ->  ("seed",   null)   the incumbent, orphaned and still in the table
   *           ("second", 1)      the new row takes the link
   *
   * The orphaning is the half that is not guessable, and getting it wrong in
   * the other direction — deleting the displaced row — is silent data loss
   * wearing the same green test. So the differential reads the table back
   * rather than only checking that the call returned.
   *
   * Without the detach the insert simply collides: the child's foreign key
   * carries the `@unique` that makes the relation a to-one, so this was a
   * `UniqueConstraintError` on a call Prisma answers. `create` survived #354
   * because that change was about the operands refused *by name* on this side,
   * and `create` was never one of them — against an *empty* to-one it has
   * always been correct, and no fixture had a to-one whose key is on the child
   * until #358 added one.
   *
   * **`clearLinks`, so the scoping consequence is the same one `set` has** —
   * which is why the two share it. A child hidden by the caller's policies is
   * not detached, and the incumbent then wins the unique key: a
   * `UniqueConstraintError` rather than a silent detach of a row the caller
   * cannot see. Conservative in the direction this file always chooses.
   *
   * Only on a to-one, and only where the key is nullable:
   *
   *   - a to-many displaces nothing, and clearing every child before a nested
   *     `create` would be a `set: []` nobody asked for;
   *   - a **required** child key has no value to leave behind, so there is no
   *     detach to run — the insert collides, which is what happens today and
   *     the only thing the schema permits. `assertDisconnectable` is not
   *     reached here for the same reason: it would refuse the whole `create`,
   *     including the empty-to-one case that works.
   */
  if (key === "create") {
    const displaces =
      relation.kind !== "many" && child.fields[childField]?.nullable === true;

    out.after.push({
      relation: relation.name,
      operation: "create",
      async run(args, _context, executor, rows) {
        const parent = rows[0];
        // No row means the statement matched nothing; `update` and `delete`
        // raise before this runs, so there is nothing to attach to.
        if (!parent) return;

        // Runs on a parent `create` too, where nothing can be linked yet and it
        // finds nothing. Deliberately not skipped by operation: gemi does not
        // enable SQLite's foreign-key pragma, so "a row that was just inserted
        // has no children" is a property of the database's enforcement rather
        // than of the ORM — and a correctness argument resting on a pragma is
        // the kind that holds until someone reads it. One read, on a path that
        // already runs several.
        if (displaces) {
          await clearLinks(relation, childField, parent[parentField], executor);
        }

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
    // `relation.kind === "many"`, not a hardcoded `true`. This side is reached
    // by both kinds — that is the whole of #116 — so a literal here told
    // `assertConnectOrCreateOperand` that a to-one takes a list, and its array
    // guard was unreachable from the one direction that needed it. The outer
    // to-one guard above now refuses the array first; this keeps the function
    // honest about which relation it was asked about rather than relying on
    // the order of two checks.
    assertConnectOrCreateOperand(
      schema,
      relation,
      child,
      operand,
      operation,
      relation.kind === "many",
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
          // ...and the column being written is *ours*, not the caller's. Without
          // this, a child whose policy scopes on its foreign key is refused for
          // a write it never made — see #98 and `ormAuthoredFields`.
          [childField],
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
  link: { parentField: string; childField: string; join?: Link["join"] },
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
    // The operand this step implements, not a two-way split of it. This read
    // `key === "create" ? "create" : "connect"`, which labelled `disconnect`,
    // `set` and `connectOrCreate` as `connect` — the first of those being the
    // opposite operation. The field exists so a plan is legible from the
    // outside, so a wrong label is the whole of its cost.
    operation: key as NestedWriteStep["operation"],
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
 * The two payloads are always required — one per branch. **The `where` is
 * required only on a to-many**, which is Prisma's own split rather than a
 * looseness: `AccountUpsertWithWhereUniqueWithoutUserInput` has `where:
 * AccountWhereUniqueInput`, while `ProfileUpsertWithoutUserInput` is
 * `{ update, create, where? }` — the to-one already knows which row it means,
 * because the parent's key names it. So the unique-key match is skipped there
 * too: a to-one `where` is a `WhereInput` filter narrowing the single linked
 * row, not a key selecting one out of many.
 *
 * Checked at plan time like every other operand here, so a missing key fails
 * when the query compiles rather than after the parent row is written.
 */
function assertUpsertOperand(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  operation: string,
  many: boolean,
): void {
  const at = `data.${relation.name}.upsert`;
  const entries = (Array.isArray(operand) ? operand : [operand]) as unknown[];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UnsupportedQueryError(
        at,
        schema.name,
        operation,
        many
          ? `Expected an object with 'where', 'create' and 'update'.`
          : `Expected an object with 'create' and 'update' — on a to-one the ` +
            `'where' is optional, since the parent's key already names the row.`,
      );
    }

    const record = entry as Record<string, unknown>;
    const required = many
      ? (["where", "create", "update"] as const)
      : (["create", "update"] as const);

    for (const name of required) {
      if (record[name] === undefined) {
        throw new UnsupportedQueryError(
          at,
          schema.name,
          operation,
          `Expected a '${name}' key — 'upsert' names the row to look for, ` +
            `what to write if it is there, and what to write if it is not.`,
        );
      }
    }

    if (!many) continue;

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
 * Detach every child currently pointing at this parent **that the caller can
 * see** — the clearing half of `set`, and the same half a nested `create` on an
 * occupied to-one needs before it can insert (#360).
 *
 * Shared rather than written twice because the *scoping* is the interesting
 * part and it has to be identical on both: the read goes through the child's
 * own `findMany` un-pre-scoped, so a row the child's policies hide is not
 * detached. `set` therefore means "replace the set I can see" (#83), and the
 * nested `create` means "displace the child I can see" — with a hidden
 * incumbent the insert collides on the unique key instead, which is the
 * conservative answer rather than a silent detach of somebody else's row.
 *
 * The `findMany` decides whether to issue the write at all. The `updateMany`
 * would match the same rows on its own; what the read adds is that the common
 * case — nothing linked — costs a select rather than an update, and that the
 * scope is consulted through a read before anything is written.
 *
 * `[childField]` is ORM-authored: the caller named a row to `set`, or a payload
 * to `create`, and the ORM chose to null this column. Without it a child scoped
 * on its own foreign key is refused by the scope-escape guard for a write it
 * never made — #98, and the reason `disconnect` one operand over passes the
 * same list.
 */
async function clearLinks(
  relation: RelationSchema,
  childField: string,
  parentKey: unknown,
  executor: RelationExecutor,
): Promise<void> {
  const linked = (await executor.exec(
    relation.model,
    "findMany",
    { where: { [childField]: parentKey }, select: { [childField]: true } },
    false,
  )) as Record<string, unknown>[];

  if (linked.length === 0) return;

  await executor.exec(
    relation.model,
    "updateMany",
    { where: { [childField]: parentKey }, data: { [childField]: null } },
    false,
    [childField],
  );
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
 *
 * **On a to-one only `data` is required, and it may have been written bare.**
 * `toOneOperand` has already turned `update: { bio: "x" }`,
 * `update: { data: … }` and `update: { where, data }` into the one form this
 * reads, so what arrives is always `{ where?, data }` — but the `where` is
 * genuinely optional there (`UpdateToOneWithWhereWithoutUserInput` spells it
 * `where?`) and it is a filter rather than a key, so `matchUniqueKey` does not
 * run on it either.
 */
function assertNamedUpdates(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  operation: string,
  many: boolean,
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
    const required = many ? (["where", "data"] as const) : (["data"] as const);

    for (const name of required) {
      if (record[name] === undefined) {
        throw new UnsupportedQueryError(
          at,
          schema.name,
          operation,
          `Expected a '${name}' key — 'update' names the row to write and ` +
            `the columns to write to it.`,
        );
      }
    }

    if (many) {
      matchUniqueKey(child, record.where, {
        model: schema.name,
        operation,
        argument: `data.${relation.name}.update.where`,
      });
    }

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
 * A to-one `disconnect` / `delete` operand, once {@link toOneOperand} has
 * translated the booleans away: `null` for the no-op, or a plain filter object.
 *
 * The counterpart of {@link assertNamedRows}, and deliberately *not* it. That
 * one runs `matchUniqueKey`, which is right where the caller is picking one row
 * out of many and wrong here: Prisma's to-one operand is a `WhereInput`, and
 * `delete: { bio: "seed" }` — a column with no unique index anywhere near it —
 * is accepted and deletes the connected row. Sharing `assertNamedRows` would
 * have refused that at compile time with a list of unique keys the caller never
 * had to name.
 *
 * `null` is the normalised `false`, and it is a *value* rather than an
 * omission: `delete: false` is a call that deliberately asks for nothing, so it
 * passes here and reduces to no statement at all further down.
 *
 * `InvalidArgumentError` because the argument is supported and the value is
 * wrong — the same reading `assertCreateManyOperand` uses, and the reason the
 * message names the two shapes that work instead of announcing a gap.
 */
function assertToOneFilter(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  operand: unknown,
  key: string,
  operation: string,
): void {
  if (operand === null || operand === undefined) return;
  if (typeof operand === "object" && !Array.isArray(operand)) return;

  throw new InvalidArgumentError(
    `data.${relation.name}.${key}`,
    schema.name,
    operation,
    `'${relation.name}' is a to-one, so '${key}' takes either a boolean — ` +
      `'true' for the connected ${child.name}, 'false' for nothing — or an ` +
      `object of filters it has to match. Prisma's operand here is ` +
      `'${child.name}WhereInput | boolean'.`,
  );
}

/**
 * The plan-time shape check for a to-one `update` / `upsert`, run **before**
 * {@link toOneOperand} rewrites the operand.
 *
 * Three holes it closes, all of the same kind: the to-one path dropped the
 * `matchUniqueKey` its to-many sibling runs — correctly, since Prisma's to-one
 * `where` is a `WhereInput` and not a unique key — and then put nothing in its
 * place, so the operand reached the step unexamined.
 *
 *   1. **A key the rewrite does not know is discarded silently.** The wrapper
 *      branch rebuilds `{ where, data }` from the keys it recognises, so
 *      `update: { data: { … }, wehre: { … } }` loses the typo and the filter
 *      with it — and `conjoin(undefined, link)` is the parent link alone, so a
 *      nested update the caller *guarded* runs unguarded. A write that should
 *      not have happened, with nothing raised anywhere. Prisma answers `Unknown
 *      argument 'wehre'`, and `assertConnectOrCreateOperand` in this file
 *      already refuses extra keys for exactly this reason.
 *   2. **A `where` that is not an object is dropped by `conjoin`**, whose first
 *      arm treats an array or a scalar as "no filter". So `upsert: { where:
 *      [{ bio: "old" }], … }` finds the connected row and takes the *update*
 *      branch, where Prisma applies the filter, matches nothing and takes the
 *      *create* branch onto a unique violation. Two different rows written.
 *   3. **A non-object operand escapes to run time.** `update: null` normalises
 *      to `{ where: undefined, data: null }`, which `assertNamedUpdates` passes
 *      because its `data` key is present — and the failure then arrives from
 *      inside the `after` step as `InvalidArgumentError('data', 'Profile',
 *      'updateMany')`, naming a model and an operation the caller never wrote,
 *      after the parent row has already been written and has to be unwound.
 *      Plan-time validation exists in this file precisely to prevent that.
 *
 * The payload spelling is deliberately *not* key-checked. `update: { bio: "x" }`
 * is the child's own `data`, so every key in it is the child's business and
 * belongs to the child's schema — checking it here would be checking the wrong
 * shape, which is the rule {@link assertNamedUpdates} states. The wrapper is
 * distinguishable because it carries a `data`, which is the same test the
 * rewrite makes one function down.
 */
function assertToOneWriteOperand(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  key: string,
  operand: unknown,
  operation: string,
): void {
  if (key !== "update" && key !== "upsert") return;

  const argument = `data.${relation.name}.${key}`;
  const refuse = (reason: string): never => {
    throw new InvalidArgumentError(argument, schema.name, operation, reason);
  };

  if (operand === null || typeof operand !== "object" || Array.isArray(operand)) {
    refuse(
      `Expected an object, got ${JSON.stringify(operand) ?? typeof operand}. ` +
        (key === "upsert"
          ? `'upsert' on a to-one takes { create, update } — and an optional ` +
            `'where' the connected ${child.name} has to match.`
          : `'update' on a to-one takes the ${child.name} columns directly, ` +
            `or { data } — and an optional 'where' the connected row has to ` +
            `match.`),
    );
  }

  const record = operand as Record<string, unknown>;
  const wrapper = key === "upsert" || record.data !== undefined;
  if (!wrapper) return;

  const known =
    key === "upsert" ? ["where", "create", "update"] : ["where", "data"];

  for (const name of Object.keys(record)) {
    if (record[name] === undefined || known.includes(name)) continue;
    refuse(
      `Unknown key '${name}'. '${key}' on a to-one takes ` +
        `${known.map((one) => `'${one}'`).join(", ")} and nothing else, so ` +
        `'${name}' would be dropped rather than applied — a misspelled ` +
        `'where' would turn a filtered write into an unconditional one. ` +
        `Prisma refuses the same key by name.`,
    );
  }

  if (
    record.where !== undefined &&
    (record.where === null ||
      typeof record.where !== "object" ||
      Array.isArray(record.where))
  ) {
    refuse(
      `'where' has to be an object of filters — Prisma's is a ` +
        `'${child.name}WhereInput', which narrows *which* single row is ` +
        `written rather than choosing among several. Anything else is dropped ` +
        `by the conjunction that keeps this operand on the connected row, so ` +
        `the write would land unfiltered.`,
    );
  }
}

/**
 * A `disconnect` clears a foreign key, so the column has to be nullable.
 *
 * Prisma refuses it on a required relation at the type level; here the schema
 * is the only thing that knows, so the refusal says which column and why rather
 * than letting the database report a not-null violation from inside a nested
 * step.
 *
 * `owner` and `caller` are separate parameters because they are separate
 * questions, and one parameter answering both is what went wrong. The column
 * lives on whichever side holds the foreign key — the caller's row on a to-one,
 * the child's on a to-many — and that is what the *message* has to name. The
 * *structured* model is always the caller's. Passing `owner` for both meant a
 * `User.update` reported `model = "Account"` on the foreign side while the
 * owning side reported `User`, from the same function (#112).
 */
function assertDisconnectable(
  owner: ModelSchema,
  relation: RelationSchema,
  fieldName: string,
  caller: RefusalOrigin,
): void {
  const field = owner.fields[fieldName];
  if (field && field.nullable) return;

  throw new UnsupportedQueryError(
    caller.argument,
    caller.model,
    caller.operation,
    `'${owner.name}.${fieldName}' is required, so there is no value to leave ` +
      `behind — a disconnected row would have to be deleted or repointed ` +
      `instead. Prisma does not offer 'disconnect' on a required relation ` +
      `either.`,
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
    // **Which side holds the key is read off the relation, not assumed.** This
    // sentence used to say "this row holds the foreign key" unconditionally,
    // which was true of the only caller that could pass `many: false` — the
    // owning side — and false the moment the foreign side stopped hardcoding
    // `true`. `from` is non-empty exactly on the side that holds the key, the
    // same test `planOne` makes to choose between the two planners, so the two
    // cannot drift.
    const owning = relation.from.length > 0;

    throw new InvalidArgumentError(
      at,
      schema.name,
      operation,
      `'${relation.name}' is a to-one: ` +
        (owning
          ? `this row holds the foreign key`
          : `${child.name} holds the foreign key`) +
        `, so there is one row to point at and a list has no meaning. Prisma ` +
        `refuses an array here too — as a validation error on the argument, ` +
        `which is why this is a bad value rather than a gap.`,
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
    throw new InvalidArgumentError(
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
    throw new InvalidArgumentError(at, schema.name, operation, `Expected a 'data' key.`);
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

/**
 * A to-one nested-write operand, rewritten in the spelling the to-many bodies
 * above already read.
 *
 * **Prisma's to-one nested input is a different grammar, not a subset of the
 * to-many one** — quoted from a generated client rather than from the docs
 * (`ProfileUpdateOneWithoutUserNestedInput`):
 *
 *     update      XOR<UpdateToOneWithWhereWithoutUserInput, UpdateWithoutUserInput>
 *                 where UpdateToOneWithWhereWithoutUserInput = { where?, data }
 *     upsert      { update, create, where? }
 *     disconnect  ProfileWhereInput | boolean
 *     delete      ProfileWhereInput | boolean
 *     connect     ProfileWhereUniqueInput
 *
 * Three of those differences would be got wrong by reading the to-many side and
 * assuming symmetry, so each is named with the measurement behind it:
 *
 *   - **the `where` is optional, and it is a filter.** Not a unique key —
 *     `WhereInput`, not `WhereUniqueInput` — which is why `assertToOneFilter`
 *     replaces `assertNamedRows` here and `matchUniqueKey` does not run.
 *     Measured: `delete: { bio: "seed" }` is accepted against a column with no
 *     unique index and deletes the connected row.
 *   - **the data may be written bare.** `update: { bio: "x" }` and
 *     `update: { data: { bio: "x" } }` are one operation. The owning side
 *     measured that years ago; this is the same measurement repeated on the
 *     foreign side, because the owning side's said nothing about this one.
 *   - **the boolean is not an empty filter.** `true` means the connected row;
 *     `false` means *nothing at all*, measured — `delete: false` and
 *     `disconnect: false` with a child present return the parent and leave the
 *     child exactly as it was, foreign key included.
 *
 * So `true` becomes `{}`, which `conjoin` reduces to the parent link alone —
 * precisely the one connected row — and `false` becomes `null`, which `listOf`
 * reduces to `[]`, which is no statement.
 */
function toOneOperand(key: string, operand: unknown): unknown {
  if (key === "update") {
    // A `data` key is the wrapper; anything else is the payload itself. The
    // same test `planOwningSide`'s `update` makes, deliberately — the two
    // spellings collapse to one operation, so the compiler should not have two
    // shapes of its own for them. It carries the same ambiguity, too: a child
    // with a scalar column called `data` would be read as the wrapper. Prisma's
    // own input types have that hazard by construction and it has never been
    // reachable in practice, so it is inherited rather than invented.
    //
    // **`!== undefined` rather than `in`**, and the difference is a plan-cache
    // bug rather than a style choice. `canonicalShape` drops a key whose value
    // is `undefined` (see its object branch), so `update: {}` and `update: {
    // data: undefined }` are ONE plan key. Branching on `in` gave them two
    // compilations: the first normalised and compiled, the second reached
    // `assertNamedUpdates` and was refused for a missing `data` — so whether
    // the refusal fired depended on which spelling warmed the cache. Testing
    // the value instead is what `assertNamedUpdates` itself does, one operand
    // over, and it puts both spellings on the same branch.
    //
    // This is the same defect as the `disconnect` boolean two functions down,
    // arrived at from the opposite direction: there the key was too coarse for
    // the code, here the code was finer than the key. Both are decided by
    // asking what `canonicalShape` actually records.
    if (
      operand !== null &&
      typeof operand === "object" &&
      (operand as Record<string, unknown>).data !== undefined
    ) {
      const record = operand as Record<string, unknown>;
      return { where: record.where, data: record.data };
    }
    return { where: undefined, data: operand };
  }

  if (key === "delete" || key === "disconnect") {
    if (operand === true) return {};
    if (operand === false) return null;
    return operand;
  }

  // `upsert` already arrives as `{ where?, create, update }`, and `create`,
  // `connect` and `connectOrCreate` are already singular. Returned untouched
  // rather than listed, so an operand added later does not silently acquire a
  // translation it was never measured for.
  return operand;
}
