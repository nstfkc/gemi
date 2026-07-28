import { UnsupportedQueryError } from "../errors";
import type { ModelSchema, RelationSchema } from "../schema";
import type { Binder } from "./fragment";
import {
  type NestedWriteStep,
  relatedSchema,
  resolveLink,
} from "./plan-relations";
import { matchUniqueKey } from "./unique";

/**
 * Nested writes: `connect`, shallow `create`, and `createMany`.
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
 * Everything else in Prisma's nested-write grammar — `connectOrCreate`, `set`,
 * `disconnect`, `update`, `upsert`, `delete`, `deleteMany`, `updateMany` —
 * throws `UnsupportedQueryError` naming the operation *and the reason*; see
 * `REFUSED`. They share one property, and it is the line this file draws: each
 * writes rows that **already exist**, which needs a scoping pass of its own
 * rather than the child's `onCreate`.
 *
 * Atomic since iteration 5: `$exec` opens a transaction for any plan carrying
 * steps, so a nested step that fails — or a child policy that denies — rolls
 * back the parent row too.
 */

const SUPPORTED = new Set(["connect", "create", "createMany"]);

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
  connectOrCreate:
    `It is an upsert against the child, which needs the read-then-write ` +
    `fallback 'upsert' uses when 'on conflict' cannot express the target.`,
  set: `It replaces the whole set, so it has to disconnect what is there now.`,
  disconnect: `It clears a foreign key on rows this call did not name.`,
  delete: `It deletes rows this call did not name.`,
  deleteMany: `It deletes rows this call did not name.`,
  update: `It writes rows that already exist, which needs its own scoping pass.`,
  updateMany:
    `It writes rows that already exist, which needs its own scoping pass.`,
  upsert: `It is 'update' and 'connectOrCreate' at once.`,
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

    planOne(schema, relation, node, operation, locate, planning);
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
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new UnsupportedQueryError(
      `data.${relation.name}`,
      schema.name,
      operation,
      "Expected an object holding 'connect' or 'create'.",
    );
  }

  // Prisma's implicit many-to-many writes rows into a join table that has no
  // model, so nothing here can express them.
  if (relation.joinTable) {
    throw new UnsupportedQueryError(
      `data.${relation.name}`,
      schema.name,
      operation,
      `${relation.name} is an implicit many-to-many. Writing through its join ` +
        `table is not implemented yet.`,
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

  if (keys.length === 0) return;

  const child = relatedSchema(schema, relation);
  const link = resolveLink(schema, child, relation, operation);

  // `from` is non-empty exactly on the side that holds the foreign key.
  const owning = relation.from.length > 0;

  for (const key of keys) {
    const operand = (node as Record<string, unknown>)[key];
    const at = (args: any) => locate(args)?.[key];

    if (owning) {
      planOwningSide(
        schema, relation, child, link, key, operand, operation, at, out,
      );
    } else {
      planForeignSide(
        schema, relation, child, link, key, operand, operation, at, out,
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

  // `connect`. In the common case the caller already handed us the referenced
  // value — `connect: { id: 1 }` where the relation references `id` — and no
  // query is needed at all: it is one more bound column.
  //
  // Whether that is the case is a property of the argument *shape*, not of its
  // values, so the choice is made here at compile time and the two forms are two
  // plans. That is what keeps a `connect` from silently costing a round trip.
  if (typeof operand !== "object" || operand === null || Array.isArray(operand)) {
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
