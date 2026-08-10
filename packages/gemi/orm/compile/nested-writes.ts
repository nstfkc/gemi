import {
  InvalidArgumentError,
  RecordNotFoundError,
  UnknownFieldError,
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
import { COMPOSITE_IN } from "./where";

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
 * The rest of Prisma's nested-write grammar — `set`, `disconnect`, `update`,
 * `upsert`, `delete`, `deleteMany`, `updateMany` — is implemented too, and this
 * paragraph used to say that all seven throw. What is left refused is refused
 * by *shape* rather than by name, at the site that knows why: the four
 * collection operands on a to-one, which Prisma's to-one input does not carry
 * either; `delete` through a key on this row, which would remove a row the
 * statement is not about (#391 left it the only one of the seven still refused
 * on that side); everything in {@link EXISTING_ROW_ONLY_STATEMENTS} under a
 * `create`; and the four that reach the far row *through* an implicit
 * many-to-many's pairs. `REFUSED` — the table this sentence pointed at — is
 * empty, and its docblock says why that is worth reading.
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

const SUPPORTED_STATEMENTS = [
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
] as const;

/**
 * One of {@link SUPPORTED_STATEMENTS}.
 *
 * `NestedCreate` and `NestedUpdate` in `../types` are mapped types over this
 * and the two tuples below, rather than four hand-written key lists in another
 * file. Which statements exist, and which exist only on a to-many or only on a
 * statement with a row to act on, are decisions made *here* — and until #369
 * the caller-facing type made them a second time, with nothing checking that
 * the two answers matched.
 */
export type NestedWriteStatement = (typeof SUPPORTED_STATEMENTS)[number];

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_STATEMENTS);

/**
 * Operands that only exist on a statement with a row to act on.
 *
 * Prisma refuses `disconnect` and `delete` under a `create` — *"Unknown
 * argument `disconnect`"* — and it is right to: there is nothing linked to a
 * row that does not exist yet. Refused here rather than accepted and made a
 * no-op, so a caller who wrote one on the wrong operation hears about it.
 */
const EXISTING_ROW_ONLY_STATEMENTS = [
  "disconnect",
  "delete",
  "update",
  "set",
  "updateMany",
  "deleteMany",
  "upsert",
] as const;

/** One of {@link EXISTING_ROW_ONLY_STATEMENTS}. `NestedCreate` subtracts it. */
export type ExistingRowStatement = (typeof EXISTING_ROW_ONLY_STATEMENTS)[number];

const EXISTING_ROW_ONLY: ReadonlySet<string> = new Set(
  EXISTING_ROW_ONLY_STATEMENTS,
);

/**
 * The operands that describe *many* rows, and so exist on a to-many alone.
 *
 * Prisma's to-one nested input is `{ create, connectOrCreate, upsert,
 * disconnect, delete, connect, update }` — measured off a generated client —
 * with no `createMany`, `set`, `updateMany` or `deleteMany` key at all. Both
 * {@link planOwningSide} and {@link planForeignSide} refuse all four on a
 * to-one; this is the list they refuse, named once so the type can subtract it.
 */
const COLLECTION_ONLY_STATEMENTS = [
  "createMany",
  "set",
  "updateMany",
  "deleteMany",
] as const;

/** One of {@link COLLECTION_ONLY_STATEMENTS}. The to-one arms subtract it. */
export type CollectionOnlyStatement = (typeof COLLECTION_ONLY_STATEMENTS)[number];

/**
 * The three of the four that share one refusal message.
 *
 * `createMany` is excluded because it is refused on its own, in both planners,
 * with a message about there being *one related row* rather than about there
 * being no *set of rows* — and on the foreign side that refusal also guards the
 * operand check that follows it. Derived by subtraction rather than written out
 * again, so a fifth collection-shaped operand added above lands here too.
 */
const NO_SET_OF_ROWS: ReadonlySet<string> = new Set(
  COLLECTION_ONLY_STATEMENTS.filter((statement) => statement !== "createMany"),
);

/** Statements that insert a new row, so nothing is linked to it yet. */
const CREATE_ONLY_STATEMENTS = new Set(["create", "createMany"]);

/**
 * The owning-side operands that decide what this row's foreign key holds — one
 * column, so at most one of them can. See where `planOne` refuses the rest.
 *
 * `update` and `delete` are not here and it is not an omission: `update` writes
 * the *far* row and leaves the key alone, and `delete` is refused on this side
 * outright.
 */
const RESOLVES_THE_KEY: ReadonlySet<string> = new Set([
  "connect",
  "connectOrCreate",
  "create",
  "disconnect",
  "upsert",
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

  /** Which relation contributed each foreign-key column, for the guard below. */
  const contributedBy = new Map<string, string>();

  for (const key of entries) {
    const relation = schema.relations[key];
    const node = (data as Record<string, unknown>)[key];
    const locate = (args: any) => locateData(args)?.[key];
    const before = planning.contributions.length;

    planOne(schema, relation, node, operation, locate, planning, dialect);

    // **Two relations that share a foreign-key column are refused by name**
    // (#271). A composite relation joins on *n* columns and nothing stops two
    // of them from sharing one — it is the tenant-scoped shape this whole
    // change is about:
    //
    //     ledger Ledger @relation(fields: [tenantId, ledgerCode], …)
    //     note   Ledger @relation(fields: [tenantId, noteCode],   …)
    //
    // `prisma validate` accepts that on 6.19.2, and before #271 both relations
    // were refused here for their width, so writing through both at once was
    // unreachable. It is reachable now, and the two `tenantId` contributions
    // collide: `insertColumns` folds contributions through a `Map` keyed by
    // field, so the later one wins, and `entries` above is sorted, so the
    // winner is whichever relation sorts last.
    //
    // **Prisma resolves the operands in the opposite direction and lets the
    // first resolved win, so the caller's last `data` key decides the shared
    // column** — measured on 6.19.2 with query events on: writing
    // `{ note: connect(2,"b"), ledger: connect(1,"a") }` stores `tenantId=1`
    // where `{ ledger: …, note: … }` stores `2`. gemi stores `2` either way.
    //
    // Matching that would mean giving up the sorted key order, which the plan
    // cache needs — two argument objects differing only in key order have to
    // be one plan. So this refuses instead, which is what the width refusal
    // this change replaced was buying: no plausible wrong row. A caller who
    // wants both links connects through one relation — which writes the shared
    // column — and sets the other relation's remaining columns directly, since
    // `insertColumns` only refuses a column that is written *both* ways.
    for (let index = before; index < planning.contributions.length; index++) {
      const field = planning.contributions[index].field;
      const owner = contributedBy.get(field);
      if (owner !== undefined && owner !== key) {
        throw new UnsupportedQueryError(
          `data.${key}`,
          schema.name,
          operation,
          `'${field}' is written by both the '${owner}' and '${key}' relations, ` +
            `which join on it in common. Prisma lets the last key in 'data' win; ` +
            `gemi plans relations in a fixed order and will not guess which row ` +
            `you meant. Write one of them through the relation and set the ` +
            `other's own columns directly.`,
        );
      }
      contributedBy.set(field, key);
    }
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

  // **Every joined field, not the first one** (#271).
  //
  // This used to be `singleFieldLink(resolveLink(…))`: reading across
  // `@relation(fields: [tenantId, orderId], references: [tenantId, id])` was
  // implemented by #67 on all six read surfaces, and the write surface refused
  // it by name rather than joining on the first field and writing plausible
  // wrong rows. The refusal was honest and it was the only thing left on that
  // list, so the narrowing is gone and what follows contributes *n* foreign-key
  // columns wherever it used to contribute one.
  //
  // Nothing here branches on how many there are. The two sides read the link
  // through {@link childLink}, {@link keySelect} and {@link nullKey}, which are
  // the same three shapes for one field as for four — so a relation joining on
  // one field compiles to exactly the arguments it did before, and there is no
  // single-field path left to diverge from the composite one.
  const link = resolveLink(schema, child, relation, operation);

  // An implicit many-to-many is *neither* side: the keys live in a third table
  // with no model, so both directions are the same work and the operand set is
  // wider — `disconnect` and `set` are a delete against the join table, which
  // needs no schema to compile.
  if (link.join) {
    // **The one caller that still cannot take more than one field**, and it is
    // an invariant rather than a gap: Prisma's implicit many-to-many links
    // parent and child by their *primary keys*, one column each side, into a
    // two-column join table there is no schema to widen. `singleFieldLink`
    // states that rather than letting `planJoinTable` index into `[0]` and be
    // silently wrong if it ever stopped holding.
    const pair = singleFieldLink(link, schema, relation, operation);

    for (const key of keys) {
      planJoinTable(
        schema,
        relation,
        child,
        pair,
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

  /**
   * **Two operands on one to-one, both writing the same foreign key** — refused
   * here, because the one that runs last is the one that wins and nothing tells
   * the caller which that was.
   *
   * On this side every one of {@link RESOLVES_THE_KEY} compiles to the same two
   * things: a `before` step that writes `context.resolved[fkField]`, and a
   * contribution reading it back. `updateAssignments` folds the contributions
   * through a field-keyed Map, so *n* of them are one assignment — and the
   * steps run in the sorted order above, so the alphabet decides. `"connect" <
   * "disconnect" < "upsert"`:
   *
   *     data: { organization: { disconnect: true, upsert: { … } } }
   *
   * edited the current organization and wrote `organizationId` back unchanged.
   * The user was not detached, and nothing was raised. The same arguments were
   * an `UnsupportedQueryError` until `upsert` landed on this side (#391), which
   * is what turned a told caller into a silent one — but the pairs that were
   * always accepted, `connect` beside `disconnect` and either beside `create`,
   * had the same defect and are refused with them.
   *
   * The *foreign* side has no equivalent: each operand there is its own
   * statement against the child's own rows, so two of them compose rather than
   * collide. This is a property of a single column being the whole link.
   *
   * `disconnect: false` is excluded because it plans nothing at all — its
   * branch returns before it contributes, which is the same value-at-plan-time
   * test {@link toOneOperand} already makes — so it can neither swallow another
   * operand nor be swallowed. That keeps the conditional spelling working.
   */
  if (owning) {
    const resolvers = keys.filter((key) => {
      if (!RESOLVES_THE_KEY.has(key)) return false;
      const operand = (node as Record<string, unknown>)[key];
      return key !== "disconnect" || (operand !== false && operand !== null);
    });

    if (resolvers.length > 1) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.${resolvers[1]}`,
        schema.name,
        operation,
        `'${resolvers.join("' and '")}' both decide what ` +
          `'${schema.name}.${link.parentFields.join("', '")}' ` +
          `${link.parentFields.length > 1 ? "hold" : "holds"}, and this row ` +
          `has one such link — so only the last of them would survive into the ` +
          `statement and the rest would be dropped without a word. Name the ` +
          `one you mean.`,
      );
    }
  }

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
 * before the insert can bind, and the whole thing collapses to *n* extra
 * columns — one, in the ordinary schema; as many as the relation joins on in a
 * tenant-scoped one (#271).
 *
 * **The columns are contributed to the statement the caller already asked for,
 * which is what makes a composite key here atomic without arranging anything.**
 * `contributions` is a list keyed by field, and `insertColumns` /
 * `updateAssignments` fold every entry into the single `INSERT` or `UPDATE`
 * this operation compiles to — so "some keys written, some not" is not a state
 * this side can reach: the `before` step either resolves the whole tuple or
 * throws, and the statement either runs or does not. The partial-write hazard
 * is real on the *foreign* side, where each linked row is its own statement,
 * and it is answered there by the transaction every plan carrying steps opens.
 */
function planOwningSide(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  link: Link,
  key: string,
  operand: unknown,
  operation: string,
  at: (args: any) => any,
  out: NestedWritePlanning,
): void {
  // `parentFields` are the FK columns on this model; `childFields` are what
  // they reference on the other one, paired positionally.
  const fkFields = link.parentFields;
  const referencedFields = link.childFields;

  /** Assign the resolved key onto the statement — one contribution per column. */
  const contributeResolved = () => {
    for (const field of fkFields) {
      out.contributions.push({
        field,
        value: (_args, context) => context.resolved[field],
      });
    }
  };

  /** Record a whole key on the plan's per-call scratch space. */
  const resolveKey = (
    context: { resolved: Record<string, unknown> },
    values: readonly unknown[],
  ) => {
    for (let index = 0; index < fkFields.length; index++) {
      context.resolved[fkFields[index]] = values[index] ?? null;
    }
  };

  /**
   * **Whether linking through this relation has to displace a sibling** — the
   * one-to-one case, where this row's foreign key carries the `@unique` that
   * makes the far row hold one partner, so pointing at an occupied one is a
   * collision rather than a second link (#363).
   *
   * **It takes both halves: the unique index *and* the far side's `kind`.** The
   * first draft of this used the index alone, on the argument that
   * `planForeignSide`'s `relation.kind` test and this one were "the same
   * predicate, two spellings". They are not, and the difference is a silent
   * destructive write rather than a wording problem.
   *
   * The implication holds one way only. P1012 gives *`kind !== "many"` implies
   * the key is unique* — Prisma will not let a non-list back-relation exist
   * beside a foreign key with no `@unique`. **The converse is false.** A
   * `@unique` foreign key beside a *list* back-relation is a schema Prisma
   * accepts:
   *
   *     model Team   { id Int @id  players Player[] }
   *     model Player { id Int @id  teamId Int? @unique
   *                    team Team? @relation(fields: [teamId], references: [id]) }
   *
   * `prisma validate` on that is *"The schema at b.prisma is valid"* — measured,
   * not assumed. And the index alone would have displaced there, where Prisma
   * does not: `Player.update({ where: { id: 2 }, data: { team: { connect:
   * { id: 2 } } } })` with player 1 already on team 2 answers **P2002** and its
   * whole statement log is `SELECT Team.id`, the `UPDATE`, `ROLLBACK` — the
   * sibling is never even read. Against the same key with `keeper Keeper?` in
   * place of `players Player[]`, the identical call displaces and the log gains
   * the incumbent `SELECT` and its clear. So the *back-relation* is what
   * decides, and the index is a necessary condition rather than the answer.
   *
   * It is not an exotic shape either: a `@unique` added to a foreign key for
   * indexing, or a one-to-many half-migrated to a one-to-one, both land on it.
   * Without the second half gemi's two ends disagreed about one relation — the
   * foreign side saw `kind === "many"` and refused to displace, this side saw
   * the index and did.
   *
   * So `relation.kind` is still not readable from here — it says `"one"` for a
   * many-to-one and a one-to-one alike, because both point at a single far row,
   * which is the part of the original argument that survives. The question goes
   * to the *child's* copy of the relation instead, found by `relationName`, and
   * `uniques` narrows it rather than answering it.
   *
   * **A back-relation that cannot be identified does not displace.** Absent or
   * ambiguous, the answer is unknown, and of the two ways to be wrong only one
   * writes to a row nobody named — so the fallback is the collision this
   * operand raised before #363, which is also what a schema too malformed to
   * read should get. The self-relation exclusion is `otherSide`'s, restated
   * rather than shared because that function *throws* on the same condition and
   * has never run on this path: turning a schema that compiled yesterday into a
   * hard error is not this issue's to do.
   *
   * Nullable, for the same reason the foreign side is: a detach has to leave a
   * value behind. A required foreign key cannot be nulled, so the repoint
   * collides as it always did. That is not what Prisma answers — it refuses
   * ahead of the write with P2014, *"The change you are trying to make would
   * violate the required relation"*, measured on a scratch schema, since this
   * one carries no required one-to-one for a case to reach. Recorded rather
   * than matched: it is a divergence in the failure's *class* on a call that
   * fails either way, where every other line of this is about a call that
   * succeeds. `assertDisconnectable` is deliberately not called, exactly as on
   * the foreign side: it would refuse the whole operand, including the
   * empty-far-row case that has always worked.
   *
   * **An index over exactly the relation's own fields**, which is what the
   * single-field test used to say and reads differently now that there may be
   * several (#271). Prisma's rule is on the relation: *"A one-to-one relation
   * must use unique fields on the defining side"*, meaning `fields` — so
   * `@@unique([tenantId, ownerId])` beside `@relation(fields: [tenantId,
   * ownerId], …)` is the composite one-to-one, and it is the same fact the
   * single-column form was stating.
   *
   * **Both halves of that rule are Prisma's, measured on 6.19.2 rather than
   * inferred**, because between them they are the whole discriminator:
   *
   *     @@unique([tenantId, ledgerCode])         accepted — the one-to-one
   *     @@unique([tenantId, ledgerCode, seal])   P1012, "Either add an
   *                                              `@@unique([tenantId,
   *                                              ledgerCode])` attribute"
   *     @@unique([ledgerCode, tenantId])         the identical P1012
   *
   * So a wider group does *not* make the relation one-to-one — reading it as
   * one would clear rows the schema never said were exclusive — and the order
   * has to match the relation's `fields` as well.
   *
   * Written as set equality all the same, and the second row is why that is not
   * laxity: the length check is what carries the weight, and a positional loop
   * would read as though order were a thing this had decided, when on any
   * schema Prisma accepted the two lists are already identical. It also keeps a
   * hand-built `ModelSchema` — a fixture, or a generator that reorders — out of
   * the branch where the index is not recognised at all.
   *
   * A foreign key that is also the `@id` would not be found in `uniques`, which
   * records `@unique` and `@@unique` rather than the primary key; it is out of
   * reach anyway, since `@id` implies `NOT NULL` and the nullable guard has
   * already excluded it.
   */
  const backRelations = Object.values(child.relations).filter(
    (candidate) =>
      candidate.relationName === relation.relationName &&
      // A self-relation names the same model on both ends, so the *field* is
      // what distinguishes them — `otherSide`'s test, and without it a
      // self-referencing one-to-many would find its own owning side here,
      // read `kind: "one"` off it and displace.
      !(child.name === schema.name && candidate.name === relation.name),
  );

  const keyed = new Set(fkFields);

  const displaces =
    fkFields.every((field) => schema.fields[field]?.nullable === true) &&
    schema.uniques.some(
      (unique) =>
        unique.length === keyed.size && unique.every((name) => keyed.has(name)),
    ) &&
    backRelations.length === 1 &&
    backRelations[0].kind !== "many";

  /**
   * Whether there is a row to displace *from* — false under a `create`, where
   * this row does not exist yet, so nothing it holds can be the incumbent.
   */
  const existing = !CREATE_ONLY_STATEMENTS.has(operation);

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
          { data: at(args), select: keySelect(referencedFields) },
          // NOT pre-scoped. Nothing walks `data.<relation>.create`, so the
          // child's own `onCreate` is the only thing that can scope this row.
          false,
        )) as Record<string, unknown> | null;

        resolveKey(context, valuesOf(created, referencedFields));
      },
    });
    contributeResolved();
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
    assertDisconnectable(schema, relation, fkFields, {
      model: schema.name,
      operation,
      argument: `data.${relation.name}.disconnect`,
    });

    // `true` -> `{}`, `false` -> `null`, a filter passes through: the same
    // translation and the same shape check the foreign side runs, reused rather
    // than restated so the two sides cannot answer one grammar differently
    // again — which is the defect #359 was filed for.
    //
    // The check goes **first**, on the operand as written: the translation is
    // lossy in the one direction that matters, since it maps `false` onto the
    // same `null` a caller may have spelled outright. See `assertToOneFilter`.
    assertToOneFilter(schema, relation, child, operand, key, operation);
    const filter = toOneOperand(key, operand);

    // `false` — no contribution and no step, so the operand contributes
    // *nothing at all*: a `data` carrying only this compiles to the read
    // `compileUpdate` emits for an empty assignment list, and the row comes
    // back with its link intact. That is Prisma's answer, and the reason the
    // differential asserts it by value: what this replaces was a write.
    if (filter === null || filter === undefined) return;

    /**
     * `true` — the link's columns bound to `null`, exactly as `connect`'s
     * direct form binds them to a value. No step, nothing on the child read or
     * written, and so no scoping question: the row being changed is the one the
     * statement already names.
     */
    if (operand === true) {
      for (const field of fkFields) {
        out.contributions.push({ field, value: () => null });
      }
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
     * The parent read is {@link readOwnKey}, which is where its two flags are
     * argued — the same read `upsert` and `displaceSibling` take, and the same
     * argument, which is why it is one function rather than three paragraphs.
     */
    out.before.push({
      relation: relation.name,
      operation: "disconnect",
      async run(args, context, executor) {
        // Default to the values that are already there, so a filter that
        // matches nothing writes the columns back unchanged. The contributions
        // are in the SET list either way — the statement's text cannot depend
        // on a value read at bind time — so "nothing happens" has to be spelled
        // as assignments that change nothing rather than as absent ones.
        resolveKey(context, nullsFor(fkFields));

        const parent = await readOwnKey(
          schema.name,
          fkFields,
          args?.where,
          executor,
        );

        const linked = valuesOf(parent, fkFields);
        // Nothing linked: no row for the filter to match, and Prisma is silent
        // about it. `null` is already what the columns hold. A *partially*
        // written composite key lands here too, and that is the right answer —
        // it joins to no row, so no filter can match through it.
        if (!isLinked(linked)) return;

        resolveKey(context, linked);

        const matched = await executor.exec(
          relation.model,
          "findFirst",
          {
            // `AND`, not a spread: a filter naming a referenced column itself
            // must narrow rather than replace the restriction that keeps this
            // on the linked row. Same rule as everywhere else here.
            // `link` reads the same way on this side: its `parentFields` are
            // this row's foreign key and its `childFields` are what they
            // reference, so `childLink` yields the far row's own columns bound
            // to the values just read off this one.
            where: conjoin(at(args), childLink(link, parent as Record<string, unknown>)),
            select: keySelect(referencedFields),
          },
          false,
        );

        if (matched) resolveKey(context, nullsFor(fkFields));
      },
    });

    contributeResolved();
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
    out.keyFields.push(...fkFields);

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

        // A composite key with any column null names no row — see
        // {@link isLinked} — so a half-written link is the *absent* case here
        // rather than a lookup that finds nothing later.
        if (!isLinked(valuesOf(parent, fkFields))) {
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
        const where = conjoin(filter, childLink(link, parent));

        if (filter !== undefined) {
          const found = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: keySelect(referencedFields) },
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
   * The list operands, refused by name on a to-one.
   *
   * `set`, `updateMany` and `deleteMany` describe *many* rows, and this side
   * has one by construction — Prisma does not offer them here either. They were
   * in `SUPPORTED` with no branch on this side, so they fell through to the
   * `connect` handling below and reported `connect` back to a caller who wrote
   * something else. Same fall-through as `upsert`'s, found by the same test.
   *
   * The fourth collection operand, `createMany`, is refused above this with its
   * own wording, which is why the set read here is {@link NO_SET_OF_ROWS} and
   * not {@link COLLECTION_ONLY_STATEMENTS} whole.
   */
  if (NO_SET_OF_ROWS.has(key)) {
    throw new UnsupportedQueryError(
      `data.${relation.name}.${key}`,
      schema.name,
      operation,
      `'${relation.name}' is a to-one: this row holds a single foreign key, so ` +
        `there is no set of rows for '${key}' to act on. Prisma does not ` +
        `accept it here either. Use 'connect', 'disconnect' or 'update'.`,
    );
  }

  /**
   * `upsert` through a to-one whose key is on **this** row — update the far row
   * this one points at, or mint one and point at it (#391).
   *
   * **Its refusal named a write-back that this side does not need**: *"an
   * absent far row would have to be created and then written back to a
   * `<parent>` that has already been inserted"*. It has not been inserted. The
   * statement the caller asked for is the one this step runs *before*, so a
   * created row's key reaches it as a contribution — which is exactly what the
   * `create` and `connectOrCreate` branches above already do, and they are the
   * two operands either side of this one. What was genuinely missing was
   * deciding the branch, and that is a lookup, the same one `connectOrCreate`
   * has been deciding since #94. The seventh refusal in this file to describe
   * machinery one layer down.
   *
   * The refusal also pointed at a workaround that does not exist here: *"upsert
   * the `<child>` directly, then 'connect' it"*. On the **foreign** side that
   * works, because the child carries the back-reference to key the upsert on —
   * `Image.upsert({ where: { thumbnailForMediaId: id }, … })`, which is what
   * #354 shipped. On this side there is no such column: the link is this row's
   * `previewImageId`, and `Image` has nothing pointing back. So the caller was
   * being sent to a spelling with nothing to put in its `where`, and the real
   * workaround — read the foreign key, then branch by hand into `create` or
   * `update` — was left to be rediscovered per call site. That is the half of
   * #391 a wording fix would not have closed.
   *
   * **A `before` step, and the branch is decided from the parent's own key** —
   * {@link readOwnKey}, because the far row is identified by a column of this
   * row which the arguments do not carry. Then:
   *
   *     nothing linked                    ->  create it and take the new key
   *     linked, and the far row matches   ->  update it, key written back unchanged
   *     linked, and it does not           ->  `RecordNotFoundError`, nothing written
   *
   * Measured against 6.19.2/SQLite on `Profile.user` (a one-to-one) and
   * `User.organization` (a many-to-one), which answer identically:
   *
   *     no where, nothing linked   insert the far row, update this row's key
   *     no where, linked           select the far row, update it, **this row is
   *                                not written at all**
   *     where matching, linked     the same update, filtered
   *
   * **`linked` decides the branch, and nothing on the far side can move it.**
   * That is the third row, and it is the rule the rest of this side already
   * follows rather than a special case for `upsert`: no owning-side operand
   * repoints a link the caller did not name a new target for. Reaching the
   * create branch from a *linked* parent would be exactly that repoint — and
   * silently, since the row it moves off is by construction one the lookup did
   * not return. Three separate conditions arrive there:
   *
   *   - the operand's `where` matches nothing, so a filter the caller wrote to
   *     *guard* the write would have caused a bigger one;
   *   - the linked child is hidden by the child's own policies — soft-deleted,
   *     another tenant's — which is when "mint a second one and repoint" is
   *     most expensive and least visible, and an application looping over such
   *     rows accumulates duplicates and loses the originals;
   *   - the foreign key is dangling, which is the one case where creating is
   *     arguably right, and is unreachable with the constraint enforced.
   *
   * One answer for all three, and it is the one the `update` operand two
   * branches up already gives for its own filtered miss: `RecordNotFoundError`,
   * which is Prisma's P2025 and this file's word for "the row this points at
   * was not found". The create branch is for a parent that points at nothing.
   *
   * **Nothing displaces**, then, in either branch that writes: the update
   * branch keeps the link it found, and the create branch mints a row a line
   * earlier, so nothing can already be pointing at it — `connectOrCreate`'s miss
   * branch says the same thing in the same words, and Prisma agrees by
   * construction: its log for the create branch is the insert and the repoint,
   * with no incumbent lookup in it.
   *
   * **KNOWN DIVERGENCE — a `where` that matches nothing fails on both clients,
   * and Prisma's failure is a bug.** It splices the operand's filter into the
   * *parent's* `UPDATE`, so its create branch emits
   * `update "Profile" set "userId" = ? where ("id" in (?) and "User"."name" = ?)`
   * — a column of the far table in this row's statement — and answers P2022,
   * *"The column `main.User.name` does not exist in the current database"*,
   * having already inserted the far row inside the transaction it then rolls
   * back. Measured on SQLite on both relation shapes above and on the composite
   * `LedgerNote.ledger`; the statement is invalid on Postgres too, though as a
   * missing `FROM`-clause entry rather than an unknown column, so the pin
   * asserts the failure and not its class. Both write nothing, which is the
   * part a caller can act on; the *kind* differs — `notFound` against `other` —
   * so it is pinned in `writes.differential.test.ts` rather than matched.
   * Refusing the `where` outright is what this must not do: the *hit* branch of
   * the same operand is correct on both clients.
   *
   * **The hit branch writes this row's foreign key back unchanged**, which is
   * the one thing here that costs anything: the contribution is in the SET list
   * whether or not the branch that changes it ran, because a statement's text
   * cannot depend on a value read at bind time. On a model carrying
   * `@updatedAt` that stamps a row Prisma leaves alone. Pre-existing rather than
   * introduced — it is the same mechanism, and the same trade, as the owning
   * side's `disconnect` filter arm, whose measurements are in
   * `updateAssignments`' docblock in `write.ts`.
   *
   * A branch of its own is also what keeps the refusals honest, and that is why
   * this sits above `connect` rather than after it. With none, the operand fell
   * through to the `connect` handling and reported *"'where' yet
   * (Organization.update.organization.connect)"* — a different operand, a
   * different model, and a claim that `{ id: 1 }` is not a unique field when it
   * is. That is the shape #85 was filed for and #101 fixed on its own path.
   */
  if (key === "upsert") {
    // Both checks, in this order, and neither subsumes the other: the first is
    // the to-one *shape* — an array, a scalar, a misspelled `where` that would
    // otherwise be dropped and turn a filtered write into an unconditional one
    // — and the second is `upsert`'s own grammar, that both payloads are there.
    // `false` rather than `many`, for the reason its docblock gives: a to-one's
    // `where` is an optional `WhereInput`, not a unique key.
    assertToOneWriteOperand(schema, relation, child, key, operand, operation);
    assertUpsertOperand(schema, relation, child, operand, operation, false);

    /**
     * The `update` payload's column names, read here rather than in the step.
     *
     * `canonicalShape` records which keys an argument object carries when it
     * builds the plan key, so *which columns the branch writes* is a property
     * of the plan and not of this call's values — which is what lets the two
     * questions below be asked once, at compile time, and their answers baked
     * into the step.
     */
    const wrapper =
      operand !== null && typeof operand === "object" && !Array.isArray(operand)
        ? (operand as Record<string, unknown>).update
        : undefined;
    const payload =
      wrapper !== null && typeof wrapper === "object" && !Array.isArray(wrapper)
        ? (wrapper as Record<string, unknown>)
        : {};
    const written = Object.keys(payload).filter(
      (name) => payload[name] !== undefined,
    );

    /**
     * **A nested write in the update payload, refused here so the refusal names
     * the query the caller wrote.**
     *
     * The update branch reaches the far row through the child's `updateMany`,
     * which has no single row to attach nested writes to and says so — but from
     * inside a step, as `UnsupportedQueryError('data.users', 'Organization',
     * 'updateMany')` for a `User.update` the caller spelled with an `upsert`.
     * That is the misnamed-origin shape #85 was filed for and #101 fixed, and
     * this operand's own docblock cites it as the reason it needed a branch of
     * its own; arriving at it one layer further down is not an improvement.
     *
     * Refused rather than served, because the two halves of the operand
     * genuinely differ: the create branch goes through the child's `create`,
     * which plans nested writes, and the update branch cannot reach a `update`
     * with them — the row it acts on is named by a filter, not by a unique key.
     * So the honest answer is the asymmetry, stated at plan time, with the
     * spelling that does work next to it.
     */
    const nested = written.find((name) => name in child.relations);
    if (nested !== undefined) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.upsert.update.${nested}`,
        schema.name,
        operation,
        `'upsert' reaches the connected ${child.name} through a filter rather ` +
          `than a unique key, so its 'update' has no single row to attach a ` +
          `nested write to — '${nested}' would be dropped rather than applied. ` +
          `The 'create' half does accept them. Write the ${child.name} through ` +
          `its own 'update' if the row exists, or move '${nested}' into ` +
          `'create'.`,
      );
    }

    /**
     * **The update branch can move the very key this step is about to write
     * back**, and the value it wrote is the only thing that knows where to.
     *
     * `update: { code: "renamed" }` on a relation referencing `code` rewrites
     * the far row out from under the contribution, which was resolved from the
     * read taken *before* it — so the statement this step runs before would
     * bind a key naming no row. With the constraint enforced and Prisma's
     * default `ON UPDATE CASCADE` behind it the database has already carried
     * the new key across and the write-back undoes it; without the cascade the
     * parent is orphaned. Prisma issues no parent `UPDATE` at all here, so that
     * cascade is the whole of its answer.
     *
     * **Read off the payload rather than re-read from the database**, which is
     * not the cheaper of the two options but the only correct one: the columns
     * that moved are the referenced ones, and on a composite link those are
     * routinely the child's `@@id` as well — `Ledger` is exactly that — so
     * there is no key left to find the row by afterwards. The payload has the
     * answer without looking, and it is the same answer the cascade computes.
     *
     * Which restricts what may be written *to* a referenced column, and the
     * restriction is checked here: a literal, or `{ set }`, both of which name
     * the resulting value. `{ increment: 1 }` and its siblings do not — the
     * result is the database's arithmetic — so they are refused rather than
     * guessed at. Refused, not read back, because "increment a column another
     * table's key points at" has no sound answer to reach for.
     */
    const moved = referencedFields.filter((name) => written.includes(name));

    const derived = moved.find(
      (name) => literalOf(payload[name]) === UNDERIVABLE,
    );
    if (derived !== undefined) {
      throw new UnsupportedQueryError(
        `data.${relation.name}.upsert.update.${derived}`,
        schema.name,
        operation,
        `'${relation.model}.${derived}' is what ` +
          `'${schema.name}.${fkFields.join("', '")}' ` +
          `${fkFields.length > 1 ? "reference" : "references"}, so this ` +
          `statement has to write the new value into it — and an operator ` +
          `computes that value in the database rather than naming it. Write ` +
          `the value itself, or move the key change out of the nested write.`,
      );
    }

    out.before.push({
      relation: relation.name,
      operation: "upsert",
      async run(args, context, executor) {
        // Optional throughout, the way `connectOrCreate`'s reads are: the
        // plan-time checks above ran on the *shape*, and `canonicalShape`
        // records a key's presence, so a plan hit implies the same keys — but
        // nothing in a step should be the first place a missing one is a
        // `TypeError` rather than an error naming the argument.
        const record = at(args) as Record<string, unknown> | null | undefined;

        const parent = await readOwnKey(
          schema.name,
          fkFields,
          args?.where,
          executor,
        );

        // A composite key with any column null names no row — see
        // {@link isLinked} — so a half-written link is the *absent* case here
        // and takes the create branch, as does a parent this statement will go
        // on to match nothing of. Prisma reaches the second the same way: its
        // parent read finds nothing, it inserts the far row, and the failure
        // arrives from the write-back as P2025, rolling the insert back. gemi's
        // own `update` raises `RecordNotFoundError` for the same call and takes
        // this step down with it.
        if (!isLinked(valuesOf(parent, fkFields))) {
          const created = (await executor.exec(
            relation.model,
            "create",
            { data: record?.create, select: keySelect(referencedFields) },
            // NOT pre-scoped — the child's own `onCreate` scopes the new row.
            false,
          )) as Record<string, unknown> | null;

          resolveKey(context, valuesOf(created, referencedFields));
          return;
        }

        // `AND`, not a spread: a filter naming a referenced column itself
        // must narrow rather than replace the restriction that keeps this on
        // the linked row. `childLink` reads as "the row this one points at"
        // on this side — the far row's own columns bound to the values just
        // read off this one.
        const where = conjoin(
          record?.where,
          childLink(link, parent as Record<string, unknown>),
        );

        const hit = (await executor.exec(
          relation.model,
          "findFirst",
          { where, select: keySelect(referencedFields) },
          // NOT pre-scoped: the child's own policies decide which rows exist,
          // as they do for every other operand that reaches the far side.
          false,
        )) as Record<string, unknown> | null;

        // The linked row, and the caller's filter, and the child's policies all
        // have to agree — and if they do not, this row keeps the link it has.
        // The operand's docblock argues the case; the error is the `update`
        // operand's, for the condition the `update` operand also has.
        if (!hit) throw new RecordNotFoundError(relation.model, "upsert");

        // The key this row already holds, written back unchanged — except for
        // whatever the payload is about to move it to, which is a value the
        // payload names rather than one the far row can be asked for
        // afterwards. The contribution is structural either way, so "the link
        // does not move" has to be spelled as an assignment that changes
        // nothing rather than as an absent one — the rule the `disconnect`
        // filter arm states.
        //
        // **This call's values, not the plan's.** `moved` is a list of column
        // names and so a property of the shape — `canonicalShape` records a
        // literal as `number` and `{ increment: 1 }` as a subtree of its own,
        // which is what makes the plan-time check above sound — but *which*
        // number is not, and a step closing over one would write the first
        // caller's key for every caller after them.
        const updates = (record?.update ?? {}) as Record<string, unknown>;
        const next = { ...hit } as Record<string, unknown>;
        for (const name of moved) next[name] = literalOf(updates[name]);

        resolveKey(context, valuesOf(next, referencedFields));

        const applied = (await executor.exec(
          relation.model,
          "updateMany",
          { where, data: record?.update },
          // NOT pre-scoped: the child's `onUpdate` and its scope-escape
          // guard judge the payload, as they do for a nested `update`.
          false,
        )) as { count?: number } | null;

        // **Read and written under two different scopes, so the row can be
        // there for one and not the other**, and `updateMany` answers that with
        // `{ count: 0 }` rather than by raising. A policy scoping reads to the
        // tenant and mutations to rows the actor owns is the ordinary shape of
        // it. Without this the caller gets a successful `update` whose nested
        // payload was never applied — no error, no count anywhere to read — and
        // the create branch cannot cover for it, since the read already sent the
        // call down this one. Prisma either applies the update or raises P2025.
        //
        // Only where the payload names a column: `update: {}` asks for no write,
        // so a zero count is the answer rather than a mismatch, and the count is
        // the driver's rows-affected either way.
        if (written.length > 0 && applied?.count === 0) {
          throw new RecordNotFoundError(relation.model, "upsert");
        }
      },
    });

    contributeResolved();
    return;
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
          { where, select: keySelect(referencedFields) },
          // NOT pre-scoped, for the reason `connect` is not: this reads another
          // model's rows to decide what to attach, so that model's policies say
          // which rows exist. Scoped away, a hit becomes a miss and the row is
          // *created* — so the fallback branch is what keeps this from being a
          // way to observe another tenant's keys.
          false,
        )) as Record<string, unknown> | null;

        if (found) {
          const values = valuesOf(found, referencedFields);
          // A hit **is** a connect, so it displaces where the miss below cannot
          // — measured on both sides, and the reason `displaces` is consulted
          // per *branch* rather than per operand. `planForeignSide`'s table
          // records the same split from the other end (M14c / M15d).
          if (displaces) {
            await displaceSibling(
              schema,
              fkFields,
              values,
              args?.where,
              existing,
              executor,
            );
          }
          resolveKey(context, values);
          return;
        }

        const created = (await executor.exec(
          relation.model,
          "create",
          { data: at(args)?.create, select: keySelect(referencedFields) },
          // NOT pre-scoped — the child's own `onCreate` scopes the new row.
          false,
        )) as Record<string, unknown> | null;

        // No displacement on this branch, and it is not an omission: the far
        // row was minted a line ago, so nothing can already be pointing at it.
        // Prisma agrees by construction rather than by rule — its miss branch
        // logs the insert and the repoint and no incumbent lookup at all.
        resolveKey(context, valuesOf(created, referencedFields));
      },
    });

    contributeResolved();
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

  /**
   * **Single-field only, and a composite `connect` takes the lookup** (#271).
   *
   * The optimisation is "the caller already handed us the value the column
   * needs", and on a composite relation they did not: Prisma spells a
   * multi-column unique key in its *compound* form —
   * `connect: { tenantId_code: { tenantId: 1, code: "a" } }`, one argument key
   * named after the index — so there is no key here whose value is a referenced
   * column. Reading one out would mean reproducing the generator's `_`-joined
   * naming rule inside the planner, and then assuming the caller reached for
   * the group the relation *references* rather than any other unique key on the
   * child, which `connect` explicitly allows.
   *
   * So the composite case pays one `findUniqueOrThrow`, and that costs parity
   * nothing: Prisma issues the same lookup. Measured on 6.19.2 with query
   * events on, `LedgerEntry.create({ data: { amount: 1, ledger: { connect:
   * { tenantId_code: { tenantId: 1, code: "ab" } } } } })` logs
   *
   *     BEGIN IMMEDIATE
   *     select Ledger.tenantId, Ledger.code where tenantId = ? and code = ?
   *     insert into LedgerEntry (tenantId, ledgerCode, amount) values (?,?,?)
   *     select the row back
   *     COMMIT
   *
   * — the resolve is a statement there too. The zero-query path was always a
   * gemi-only shortcut over the shape where the operand *is* the value.
   */
  const direct =
    referencedFields.length === 1 &&
    (operand as Record<string, unknown>)[referencedFields[0]] !== undefined &&
    Object.keys(operand as Record<string, unknown>).filter(
      (name) => (operand as Record<string, unknown>)[name] !== undefined,
    ).length === 1;

  if (direct) {
    const referenced = referencedFields[0];
    const fkField = fkFields[0];

    /**
     * **The direct form still costs a step when it has an incumbent to
     * displace**, and only then.
     *
     * "No query is needed at all" is a claim about resolving the *operand*, and
     * it survives: the value is still read straight out of the argument tree
     * and never looked up. What a one-to-one adds is a second row that has to
     * stop holding it, which no amount of knowing the value answers.
     *
     * The condition is the schema's, not the call's, so the two forms are
     * still decided once at compile time and a many-to-one `connect` — which
     * is every `connect` in an ordinary schema — keeps the zero-query path it
     * has always had.
     */
    if (displaces) {
      out.before.push({
        relation: relation.name,
        operation: "connect",
        async run(args, _context, executor) {
          await displaceSibling(
            schema,
            [fkField],
            [at(args)?.[referenced]],
            args?.where,
            existing,
            executor,
          );
        },
      });
    }

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
        { where: at(args), select: keySelect(referencedFields) },
        // NOT pre-scoped. This lookup reads another model's rows to decide what
        // to attach, so it is that model's policies that say which rows exist —
        // otherwise a `connect` by any unique key reaches every tenant's.
        false,
      )) as Record<string, unknown> | null;

      const values = valuesOf(found, referencedFields);

      // After the lookup, which is the ordering #363 asked how to get: the
      // clear cannot be written until the referenced value is known, and
      // sitting in the same step is what orders it without having to order a
      // write between two reads that are otherwise independent. It also puts
      // the *miss* on the right side of the detach — `findUniqueOrThrow` has
      // already raised, so a `connect` naming no row displaces nothing, which
      // is Prisma's answer (P2025 with the incumbent untouched).
      if (displaces) {
        await displaceSibling(
          schema,
          fkFields,
          values,
          args?.where,
          existing,
          executor,
        );
      }

      resolveKey(context, values);
    },
  });
  contributeResolved();
}

/**
 * The *child* holds the foreign key, so nothing can be written until this row
 * exists and its key is known. Both forms are therefore `after` steps, and both
 * need the key in the statement's `RETURNING` list — **every column of it**,
 * since a composite link is only usable once the whole tuple is known (#271).
 *
 * **This is the side the partial-write hazard is real on**, and it is answered
 * rather than avoided. The owning side folds its columns into one statement;
 * here each linked row is its own `update` or `create`, so a composite key
 * whose second statement fails leaves the first row repointed. `$exec` opens a
 * transaction for any plan carrying steps — iteration 5 — so the failure rolls
 * the parent row back with it, which is the same guarantee that already covers
 * a `connect` of three rows where the third does not exist.
 */
function planForeignSide(
  schema: ModelSchema,
  relation: RelationSchema,
  child: ModelSchema,
  link: Link,
  key: string,
  operand: unknown,
  operation: string,
  at: (args: any) => any,
  out: NestedWritePlanning,
): void {
  const parentFields = link.parentFields;
  const childFields = link.childFields;

  out.keyFields.push(...parentFields);

  /**
   * **Whether linking through this relation has to displace what is linked
   * already** — the to-one case, where the child's key carries the `@unique`
   * that makes the relation hold one row, so a second link is a collision
   * rather than a second row.
   *
   * Prisma detaches the incumbent rather than deleting it, and it does so for
   * some of the operands that link and not others. That split is not derivable
   * — it is measured, on one fixture, and it is the reason `displaces` is
   * consulted per operand rather than applied to "anything that links":
   *
   *     create                    displaces the incumbent, links the new row
   *     connect                   displaces the incumbent, links the named row
   *     connectOrCreate, hit      the same — it *is* a connect (#361)
   *     connectOrCreate, miss     collides: P2002 on the child's key
   *     upsert, create branch     collides: P2002 on the child's key
   *
   * So the two branches of one `connectOrCreate` answer differently, which is
   * Prisma's asymmetry and not an embellishment: what displaces is *linking an
   * existing row*, plus the bare `create` — and the create inside the two
   * compound operands does not.
   *
   * Nullable, because a detach has to leave a value behind. A required child
   * key cannot be nulled at all, so the insert or repoint collides as it always
   * did, which is the only thing the schema permits. `assertDisconnectable` is
   * deliberately not called here: it would refuse the whole operand, including
   * the empty-to-one case that has always worked.
   *
   * **`relation.kind` is the whole discriminator here, and it is *not* the same
   * predicate as the owning side's (#363) — it is the stronger half of it.**
   * `kind` is a property of this relation's back-reference, and Prisma will not
   * let a non-list back-relation exist without `@unique` on the child's foreign
   * key. Verified against 6.19.2 rather than assumed: `User.profile Profile?`
   * beside a `Profile.userId` carrying no `@unique` is refused at parse time
   * with P1012 — *"A one-to-one relation must use unique fields on the defining
   * side. Either add an `@unique` attribute to the field `userId`, or change
   * the relation to one-to-many"* — so a schema reaching this line with
   * `kind !== "many"` **has** the index, and `kind` alone is sufficient here.
   *
   * **The converse does not hold, which is why the owning side needs two tests
   * where this one needs one.** A `@unique` foreign key beside a *list*
   * back-relation validates: `Player.teamId Int? @unique` next to
   * `Team.players Player[]` is accepted, and Prisma refuses the displacing
   * `connect` there with P2002 without reading the sibling. So "the key is
   * unique" is strictly weaker than `kind !== "many"`, and an owning-side
   * discriminator built on the index alone displaces on schemas this side
   * correctly leaves alone. That is a real defect this file shipped for one
   * review cycle; `planOwningSide`'s `displaces` now reads the *child's* copy of
   * the relation for its `kind` and uses `uniques` only to narrow. From the
   * owning side `relation.kind` is still unreadable — it says `"one"` for a
   * many-to-one and a one-to-one alike, because both point at a single far row.
   *
   * **Every column has to be nullable, not the first one** (#271). Prisma makes
   * a composite relation optional or required as a whole and refuses a mixture,
   * so on a schema it accepted the columns agree — but the test is over all of
   * them because half a detach is worse than none: the incumbent would keep a
   * key that still joins nowhere while the unique index still holds it.
   */
  const displaces =
    relation.kind !== "many" &&
    childFields.every((field) => child.fields[field]?.nullable === true);

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
  // The operand as the caller wrote it, kept because the rewrite below
  // overwrites `operand` in place and `assertToOneFilter` has to read the
  // spelling rather than the translation — `false` and `null` are one value
  // afterwards and two very different calls before. See that function.
  const spelledOperand = operand;

  if (relation.kind !== "many") {
    // {@link NO_SET_OF_ROWS} rather than {@link COLLECTION_ONLY_STATEMENTS}:
    // `createMany` is the fourth of them and is refused further down, where its
    // own message and its operand check live together.
    if (NO_SET_OF_ROWS.has(key)) {
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
          const where = conjoin(entry.where, childLink(link, parent));

          const hit = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: keySelect(childFields) },
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
              data: { ...(entry.create as object), ...childLink(link, parent) },
              select: keySelect(childFields),
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
        const where = conjoin(filter, childLink(link, parent));

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
    assertDisconnectable(child, relation, childFields, {
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

        const attach = childLink(link, parent);

        await clearLinks(
          relation.model,
          childFields,
          valuesOf(parent, parentFields),
          executor,
        );

        for (const entry of listOf(at(args))) {
          await executor.exec(
            relation.model,
            "updateMany",
            { where: entry as object, data: attach },
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
          const where = conjoin(entry.where, childLink(link, parent));

          const found = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: keySelect(childFields) },
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
      assertDisconnectable(child, relation, childFields, {
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
      assertToOneFilter(
        schema,
        relation,
        child,
        spelledOperand,
        key,
        operation,
      );
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
          const where = conjoin(list[index], childLink(link, parent));

          if (!deleting) {
            await executor.exec(
              relation.model,
              "updateMany",
              { where, data: nullKey(childFields) },
              // NOT pre-scoped: clearing a foreign key is a write to the child,
              // so the child's scope decides which rows are reachable.
              false,
              // ...but the columns are *ours*: the caller wrote `disconnect:
              // { id }` and the ORM chose to null the key. Without this a child
              // scoped on its own foreign key is refused for a write it never
              // made — the same case as `connect`, see #98 and
              // `ormAuthoredFields`.
              childFields,
            );
            continue;
          }

          const found = (await executor.exec(
            relation.model,
            "findFirst",
            { where, select: keySelect(childFields) },
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
   * A to-many displaces nothing — clearing every child before a nested `create`
   * would be a `set: []` nobody asked for — which is half of what `displaces`
   * decides; see it for the other half and for which operands share this.
   */
  if (key === "create") {
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
          await clearLinks(
            relation.model,
            childFields,
            valuesOf(parent, parentFields),
            executor,
          );
        }

        for (const item of listOf(at(args))) {
          await executor.exec(
            relation.model,
            "create",
            {
              // The foreign key is set by us, not by the caller: a nested create
              // that also named it would be describing two different parents.
              data: { ...(item as object), ...childLink(link, parent) },
              // Nothing reads the result, and the narrowest select keeps the
              // returned payload from growing with the child's column count.
              select: keySelect(childFields),
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
          ...childLink(link, parent),
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
            { where: item.where, select: keySelect(childFields) },
            false,
          )) as Record<string, unknown> | null;

          if (found) {
            // **The row is already this parent's, so there is nothing to do.**
            //
            // Free here in a way it is not for the bare `connect` below: the
            // `findUnique` above already selected the child's foreign key, so
            // the comparison costs no statement. `connect` has no such read —
            // giving it the same short-circuit means buying a lookup, which is
            // why it is #372's question rather than this branch's.
            //
            // Without this the pair below is a **clear followed by a repoint of
            // the row the clear just nulled**, and on a child scoped by that
            // same foreign key the clear puts it outside the scope the repoint
            // selects it through — so the operand raises `RecordNotFoundError`
            // on a call that should change nothing. Net-nothing either way for
            // an unscoped child, which is why it stayed hidden; the scoped one
            // is where the wasted statement becomes a wrong answer.
            //
            // `displaces` gates it because that is the only shape the clear
            // runs in. On a to-many there is no clear, so the repoint is one
            // redundant `update` writing the value already there — measured to
            // agree with Prisma, and skipping it would be an unmeasured change
            // to a branch this issue is not about.
            if (
              displaces &&
              childFields.every((field, index) =>
                sameKey(found[field], parent[parentFields[index]]),
              )
            ) {
              continue;
            }

            // The hit branch **is** a connect, so it displaces what is linked
            // exactly as the bare operand does (#361) — and the miss branch
            // below does not, which is Prisma's own split rather than a
            // shortcut here. Measured on one fixture: `connectOrCreate` hitting
            // a row orphans the incumbent and takes the link, while the same
            // call missing collides on the child's unique key. See `displaces`.
            if (displaces) {
              await clearLinks(
                relation.model,
                childFields,
                valuesOf(parent, parentFields),
                executor,
              );
            }

            await executor.exec(
              relation.model,
              "update",
              {
                where: item.where,
                data: childLink(link, parent),
                select: keySelect(childFields),
              },
              // NOT pre-scoped, for the reason the bare `connect` below is not:
              // this repoints an existing child, so the child's scope decides
              // which rows are reachable.
              false,
              // ...and the column is *ours*, the same one and for the same
              // reason (#98). Left off here while `connect` carried it, so one
              // operand spelled two ways answered a child scoped on its own
              // foreign key differently: `connect` went through and this raised
              // `ScopeEscapeError` about a `folderId` the caller never wrote
              // (#373). The hit branch **is** a connect — the docblock above
              // says so for displacement, and provenance follows from the same
              // fact. The miss branch below needs no marker: it creates the far
              // row, so there is no caller-supplied key to tell ours apart from.
              childFields,
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
              data: { ...(item.create as object), ...childLink(link, parent) },
              select: keySelect(childFields),
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

  /**
   * **On a to-one this repoint has to displace what is linked already** (#361),
   * the same way the nested `create` beside it does and through the same
   * `clearLinks`. Without it the child's `@unique` foreign key rejects the
   * second link, so `connect` was a `UniqueConstraintError` on a call Prisma
   * answers by orphaning the incumbent.
   *
   * Measured across the four shapes, because only one of them diverged and the
   * other three are what kept it hidden:
   *
   *     connect onto an empty to-one          attaches           agreed already
   *     connect a child of another parent     repoints it        agreed already
   *     connect the row already linked here   writes nothing     see below
   *     connect onto an occupied to-one       displaces          the divergence
   *
   * **The third is the one the clear and the link cross on, and #361 got it
   * right in the table and wrong in the statements** (#372). `clearLinks` nulls
   * the very row the caller named and the repoint puts the key straight back,
   * so the committed state agrees — and that is all `M15b` could see. The two
   * statements in between are not harmless. **The repoint has to re-select the
   * row by the column the clear just changed, so it fails whenever anything in
   * that `where` depends on the old value** — and there are two ways to get
   * one, not just the policy shape #372 was reported through:
   *
   *   - a child whose policy scopes on *its own foreign key*
   *     (`{ folderId: 2 }`) — the scope is `AND`ed into the repoint's `where`,
   *     and the clear has just moved the row out of it;
   *   - **no policy anywhere**, when the caller names the row *by* that foreign
   *     key (`connect: { folderId: 2 }`). `assertNamedRows` accepts that
   *     operand because the column is in `uniques`, which is the same fact that
   *     makes the relation a to-one in the first place — and then the caller's
   *     own `where` is the thing the clear invalidates.
   *
   * Either way the repoint matches nothing and the whole call raises
   * `RecordNotFoundError` naming a model and an operation the caller never
   * wrote. A call that worked before #361. The second shape is what makes this
   * a plain correctness bug rather than a policy interaction, and it is why the
   * differential can pin it at all: `M15e` in `writes.differential.test.ts` is
   * that spelling, `error` against `ok`, with no policy in it.
   *
   * So the named row is resolved first and the operand short-circuits when it
   * already points here — {@link alreadyLinked}. That is Prisma's own shape
   * rather than a repair invented for the scope: measured on 6.19.2/SQLite with
   * query logging, `folder.update({ data: { cover: { connect: { id: 30 } } } })`
   * where cover 30 already holds folder 2 logs **four selects and no `UPDATE`**
   * between its `BEGIN` and `COMMIT`, where the same call onto an occupied
   * folder logs the incumbent clear and the repoint. The lookup itself is
   * Prisma's too — every `connect` above begins by selecting the operand's row
   * with its foreign key in the projection.
   *
   * #361 declined this as "a lookup on every `connect` to save one write on a
   * rare one", which was the right trade for the fact it had in view. Two
   * things changed it: the write it saves is a live failure rather than a
   * redundancy, and the lookup is not on every `connect` — only where
   * `displaces` holds, which is a to-one, so every many-to-one and every
   * to-many `connect` costs exactly what it did.
   *
   * **A miss detaches nothing**, which is Prisma's answer (P2025, nothing
   * written) and is not a special case here: a row the lookup cannot find is
   * left to the repoint, which raises, and the clear is inside the transaction
   * the nested steps already run in. That covers the row that does not exist
   * and the row this caller's policies hide alike — both read as absent, and
   * both get the answer they had before this change.
   */
  out.after.push({
    relation: relation.name,
    operation: "connect",
    async run(args, _context, executor, rows) {
      const parent = rows[0];
      if (!parent) return;

      // `displaces` is only ever true on a to-one, where the array spelling is
      // refused above — so this is one extra select at most, never one per item.
      const pending: unknown[] = [];
      for (const item of listOf(at(args))) {
        if (
          displaces &&
          (await alreadyLinked(
            relation.model,
            childFields,
            item,
            valuesOf(parent, parentFields),
            executor,
          ))
        ) {
          continue;
        }
        pending.push(item);
      }

      // Nothing left to link means nothing to displace either: the only row that
      // could hold this parent's key is the one the caller named, and it holds
      // it already. Returning here is what makes the call write nothing at all.
      if (pending.length === 0) return;

      if (displaces) {
        await clearLinks(
          relation.model,
          childFields,
          valuesOf(parent, parentFields),
          executor,
        );
      }

      for (const item of pending) {
        await executor.exec(
          relation.model,
          "update",
          {
            where: item,
            data: childLink(link, parent),
            select: keySelect(childFields),
          },
          // NOT pre-scoped. Repointing an existing row at this parent is a write
          // to the child, and the child's scope decides which rows are reachable
          // — otherwise `connect` re-parents another tenant's row.
          false,
          // ...and the columns being written are *ours*, not the caller's.
          // Without this, a child whose policy scopes on its foreign key is
          // refused for a write it never made — see #98 and
          // `ormAuthoredFields`.
          childFields,
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

      // **Present is not the same as usable**, and the loop above only asked
      // the first question. `create: null` reached the step as `data: null`,
      // which `insertColumns` explicitly admits — so on a child whose columns
      // are all nullable or defaulted it committed a blank row and repointed
      // the parent at it, and on one with a required column it surfaced as a
      // raw NOT NULL violation from inside a nested step rather than as an
      // argument refusal. `where` is excluded because it has its own checks:
      // `matchUniqueKey` below on a to-many, `assertToOneWriteOperand` on a
      // to-one, where it is optional and a `WhereInput` rather than a key.
      const value = record[name];
      if (
        name !== "where" &&
        (value === null || typeof value !== "object" || Array.isArray(value))
      ) {
        throw new InvalidArgumentError(
          `${at}.${name}`,
          schema.name,
          operation,
          `Expected an object of ${child.name} columns, got ` +
            `${JSON.stringify(value) ?? typeof value}. Prisma refuses the same ` +
            `value at validation, with nothing written.`,
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
 * The three shapes a link takes in an argument object, and the two questions
 * asked about its *values* — written once so that a relation joining on four
 * fields goes down the same path as one joining on one (#271).
 *
 * Before these, every site spelled the link as `{ [childField]: parent[
 * parentField] }` or `select: { [childField]: true }` by hand, in about forty
 * places across the two sides. Generalising each of them separately is how a
 * composite relation ends up correlating on every field in nine operands and on
 * the first field in the tenth — a silent wrong write, which is precisely what
 * the refusal these replace was protecting against. One function per shape
 * means the count of fields is invisible to the callers, so there is no
 * single-field spelling left for a new operand to copy.
 */

/**
 * `{ <childField>: row[<parentField>], … }` — the far side's columns bound to
 * the values this row holds.
 *
 * On the foreign side that reads as "belonging to this parent": the child's
 * foreign key set to the parent's key. On the owning side the same call reads
 * as "the row this one points at": `link.parentFields` are this row's foreign
 * key and `link.childFields` are what they reference, so the object is the far
 * row's own columns. One function, because the arithmetic is identical and the
 * two sides differ only in which table the result is applied to.
 *
 * An object with several keys is a conjunction in every `where` this ORM
 * compiles, and several assignments in every `data`, so the same shape serves
 * both — which is why `create`, `connect`, `update`, `delete` and the two
 * `*Many` operands can all take it unchanged.
 */
function childLink(
  link: { parentFields: string[]; childFields: string[] },
  parent: Record<string, unknown>,
): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (let index = 0; index < link.childFields.length; index++) {
    key[link.childFields[index]] = parent[link.parentFields[index]];
  }
  return key;
}

/**
 * **This row's own foreign key**, read back inside the transaction the nested
 * steps already run in — the one lookup an owning-side operand cannot avoid,
 * because which far row it acts on lives in a column the arguments do not
 * carry.
 *
 * Written once because the *scoping* is the interesting part and three operands
 * had it spelled out identically, each re-arguing it in its own paragraph: the
 * `disconnect` filter arm, `upsert`'s branch decision, and `displaceSibling`'s
 * "does this row already point there". A change to how the key is read — either
 * flag below, a `where` that can match more than one row, what a missing parent
 * means — has to be one change, or one operand quietly gets a different rule
 * from its neighbours. That is what {@link childLink} and {@link keySelect}
 * exist to prevent one layer down, and this is the same argument for the read
 * that feeds them.
 *
 * **Pre-scoped**: `where` is the effective `where` this call already put
 * through this model's policies, so re-applying them would `AND` the same
 * predicate twice.
 *
 * **Unredacted**: the row decides a branch and is never handed back, and a
 * `redact` over the foreign key would otherwise make a linked row read as
 * unlinked — `redactNullable` permits exactly the nullable columns an optional
 * foreign key is made of. See `RelationExecutor.exec`'s parameter, where the
 * argument is. The misread is a silent no-op in `disconnect` and
 * `displaceSibling`, which have nothing to do when nothing is linked, and a
 * *destructive* one in `upsert`, which read it as a row to create.
 */
async function readOwnKey(
  model: string,
  fields: readonly string[],
  where: unknown,
  executor: RelationExecutor,
): Promise<Record<string, unknown> | null> {
  return (await executor.exec(
    model,
    "findFirst",
    { where, select: keySelect(fields) },
    true,
    undefined,
    true,
  )) as Record<string, unknown> | null;
}

/** `{ <field>: true, … }` — the narrowest select that reads a whole link back. */
function keySelect(fields: readonly string[]): Record<string, true> {
  const select: Record<string, true> = {};
  for (const field of fields) select[field] = true;
  return select;
}

/** The answer {@link literalOf} gives for a value it cannot name in advance. */
const UNDERIVABLE = Symbol("underivable");

/**
 * The value an assignment will leave in the column, when that is knowable from
 * the assignment alone.
 *
 * `"renamed"` is itself; `{ set: "renamed" }` is Prisma's explicit spelling of
 * the same thing and unwraps to it. `{ increment: 1 }` is not knowable — the
 * result is the database's arithmetic over a value nobody here has read — and
 * neither is any other operator, so they all answer {@link UNDERIVABLE} and the
 * one caller refuses rather than guessing.
 *
 * **A plain object is the test**, not "an object": `Date` and `Uint8Array` are
 * ordinary values of `DateTime` and `Bytes` columns and reach this as
 * themselves. Prisma's operator objects are always object literals, so the
 * prototype is what separates the two — and it separates them the safe way
 * round, since an exotic wrapper falls to `UNDERIVABLE` rather than being
 * written through as a value.
 */
function literalOf(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 1 && keys[0] === "set") {
    return (value as Record<string, unknown>).set;
  }
  return UNDERIVABLE;
}

/** `{ <field>: null, … }` — a detach, which has to clear *every* column. */
function nullKey(fields: readonly string[]): Record<string, null> {
  const cleared: Record<string, null> = {};
  for (const field of fields) cleared[field] = null;
  return cleared;
}

/** The same detach spelled as *values* rather than as a `data` object. */
function nullsFor(fields: readonly string[]): null[] {
  return fields.map(() => null);
}

/** The values of `fields` on `row`, positionally. */
function valuesOf(
  row: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): unknown[] {
  return fields.map((field) => row?.[field]);
}

/**
 * Whether a link's columns actually name a row.
 *
 * **A partially-null composite key links nothing**, which is SQL's rule and not
 * a choice made here: `(tenantId, orderId) = (1, NULL)` is `UNKNOWN`, so the
 * join finds no row however many other columns match. Prisma agrees at the
 * type level — an optional relation over composite fields makes *all* of them
 * optional together, and `include` on a row holding `(1, NULL)` returns `null`.
 *
 * So every place that used to test one value for `null` — "is anything linked
 * here" — tests the whole key through this, and a half-written key reads as
 * *absent* rather than as a link to a row that does not exist. Getting this
 * backwards is what would make `clearLinks` null the key of every unlinked row
 * in the table, and `disconnect`'s filter arm read a child by a `NULL` key.
 */
function isLinked(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null && value !== undefined);
}

/**
 * Null the foreign-key columns of every row that currently holds `values` **and
 * that the caller can see** — the clearing half of `set`, the half a nested
 * `create` on an occupied to-one needs before it can insert (#360), and the
 * half the owning side's `connect` needs before it can repoint (#363).
 *
 * Shared rather than written three times because the *scoping* is the
 * interesting part and it has to be identical on all of them: the read goes
 * through the target model's own `findMany` un-pre-scoped, so a row that
 * model's policies hide is not detached. `set` therefore means "replace the set
 * I can see" (#83), the nested `create` means "displace the child I can see",
 * and the owning-side `connect` means "displace the sibling I can see" — with a
 * hidden incumbent the insert or repoint collides on the unique key instead,
 * which is the conservative answer rather than a silent detach of somebody
 * else's row.
 *
 * **`model` is a parameter rather than `relation.model` because the two
 * directions clear different tables.** On the foreign side the rows holding the
 * key belong to the *child*; on the owning side they are siblings of the row
 * being written, in the model the statement is already about. Same statement
 * pair, same scoping rule, two tables — so the only thing that varies is which
 * one, and passing it is what let #363 reuse this instead of restating it.
 *
 * The `findMany` decides whether to issue the write at all. The `updateMany`
 * would match the same rows on its own; what the read adds is that the common
 * case — nothing linked — costs a select rather than an update, and that the
 * scope is consulted through a read before anything is written.
 *
 * `fields` is ORM-authored: the caller named a row to `set`, or a payload to
 * `create`, or a row to `connect`, and the ORM chose to null these columns.
 * Without it a model scoped on one of them is refused by the scope-escape guard
 * for a write it never made — #98, and the reason `disconnect` one operand over
 * passes the same list. **Every** column of the link goes in it, because a
 * composite key is cleared by writing null to all of them and each one is as
 * much the ORM's as the first.
 *
 * **A key with a null component clears nothing** (#271), and the guard is not
 * defensive tidying. `where: { tenantId: 1, orderId: null }` matches every row
 * whose order is unset in that tenant — rows linked to *nothing*, which is the
 * opposite of the set this is asked for — and the `updateMany` behind it would
 * then write null over null across all of them. See {@link isLinked}. Nothing
 * reaches here with a null today (`displaceSibling` returns first, and the
 * foreign side reads its values out of a primary key), so this buys no
 * behaviour; it means a caller that one day does cannot silently rewrite the
 * table.
 */
async function clearLinks(
  model: string,
  fields: readonly string[],
  values: readonly unknown[],
  executor: RelationExecutor,
): Promise<void> {
  if (!isLinked(values)) return;

  const where: Record<string, unknown> = {};
  for (let index = 0; index < fields.length; index++) {
    where[fields[index]] = values[index];
  }

  const linked = (await executor.exec(
    model,
    "findMany",
    { where, select: keySelect(fields) },
    false,
  )) as Record<string, unknown>[];

  if (linked.length === 0) return;

  await executor.exec(
    model,
    "updateMany",
    { where, data: nullKey(fields) },
    false,
    fields,
  );
}

/**
 * **Whether the row a `connect` named already points at this parent** — the
 * question that turns a clear-then-repoint into no statements at all (#372).
 *
 * The foreign-side twin of the `sameKey` test inside {@link displaceSibling},
 * and the same answer read from the other end of the key: on the owning side
 * the row that must not be cleared is the one being written, here it is the one
 * being named. Both exist because clearing a row and then selecting it by the
 * column just cleared is a contradiction the moment anything in that `where`
 * depends on the old value — a policy scoping on the column, or a caller who
 * named the row by it.
 *
 * **Prisma issues no write for an already-linked `connect` from either end, and
 * only this end matches that outright.** The owning side skips the *clear* and
 * still emits the repoint — {@link displaceSibling}'s docblock says so in plain
 * terms, and that residual divergence is #370's class, not something #363/#375
 * closed. Do not read the symmetry above as parity.
 *
 * **Un-pre-scoped, so the child's own policies decide what this can see** — the
 * same rule every other statement in this step follows, and it is what makes
 * the miss answer fall out rather than needing a branch. A row that does not
 * exist and a row this caller cannot see both read as absent, so both are
 * treated as "not linked here" and left to the repoint, which raises
 * `RecordNotFoundError` for them exactly as it did before.
 *
 * Getting that direction backwards would be the expensive mistake: a lookup
 * that ignored the scope could answer "already linked" for another tenant's row
 * and make the whole operand a silent no-op, which is a `connect` that reports
 * success and links nothing.
 *
 * `findUnique` rather than `findFirst` because `assertNamedRows` has already
 * run `matchUniqueKey` over this operand — the same lookup, and the same
 * spelling, that `connectOrCreate`'s hit branch uses one screen up.
 */
async function alreadyLinked(
  model: string,
  fields: readonly string[],
  where: unknown,
  values: readonly unknown[],
  executor: RelationExecutor,
): Promise<boolean> {
  const named = (await executor.exec(
    model,
    "findUnique",
    { where, select: keySelect(fields) },
    false,
  )) as Record<string, unknown> | null;

  if (named === null || named === undefined) return false;

  // **`every`, not `some`** — the row is already linked here only if the whole
  // key matches. A composite key agreeing on one column and not the rest points
  // somewhere else entirely, and short-circuiting on it would skip a repoint
  // that has to happen. This is the one site of #386's generalisation that is
  // not a rename: `sameKey` compares a single value, so the fold belongs here.
  return fields.every((field, index) => sameKey(named[field], values[index]));
}

/**
 * **Detach the sibling that already holds this foreign-key value, so the row
 * being written can take it** — the owning side of #361's displacement, and the
 * whole of #363.
 *
 * The two directions look alike and are not the same operation. On the foreign
 * side the incumbent is a row of the *child* model, reached through
 * `planForeignSide`; here it is a row of the model the statement is already
 * writing, one `@unique` foreign key away. `clearLinks` is shared between them
 * because the statement pair and the scoping rule are identical; everything
 * below is what only this side needs.
 *
 * Measured against Prisma 6.19.2 on SQLite before it was written, with query
 * logging on. `Profile.update({ where: { id: 1 }, data: { user: { connect:
 * { id: 2 } } } })` where user 2's profile is taken issues, in order:
 *
 *     select User.id where id = 2                  resolve the operand
 *     select Profile.* where id = 1                the row being written
 *     select Profile.id, userId where userId in (2)   the incumbent
 *     update Profile set userId = null where id in (2) detach it
 *     update Profile set userId = 2 where id in (1)    take the link
 *
 * all inside one `BEGIN IMMEDIATE` / `COMMIT`. The incumbent is left in the
 * table with a null key — **orphaned, not deleted** — which is the half a fix
 * in the wrong direction turns into silent data loss wearing a green test.
 *
 * **Why the row being written is skipped: because Prisma skips it too.**
 * `connect`ing the far row a caller is already connected to writes *nothing at
 * all* — measured with logging on, the whole call is
 *
 *     BEGIN IMMEDIATE / select the operand / select this row /
 *     select the operand again / select this row again / COMMIT
 *
 * with no `update` in it. So this is not a departure to be justified; it is the
 * behaviour. (An earlier draft of this docblock claimed Prisma nulls the column
 * and writes the same value straight back for a net nothing. It does not, and
 * the claim survived into four places before it was measured rather than
 * reasoned about.)
 *
 * The skip matters *more* here than it would as mere parity, which is worth
 * keeping: the repoint on this side is not a statement of its own but a
 * contribution to the main statement, whose `where` has already been through
 * this model's policies. A model scoped on the foreign key would have its own
 * row put outside that scope by a clear, so the main statement would match
 * nothing and leave the row detached and never re-attached — a silent
 * half-write, #98's hazard arriving on this side, and the same argument #362
 * used to leave `set`'s *link* half not naming its column.
 *
 * **The residual divergence runs the other way and is not fixed here.** Prisma
 * makes the whole call a no-op; gemi still emits the repoint `UPDATE`, because
 * the contribution is in the SET list at compile time and cannot be withdrawn
 * at bind time. Same rows either way — it writes the value already there — but
 * on a one-to-one owner carrying `@updatedAt` gemi bumps the stamp where Prisma
 * leaves it. That is an instance of the stamp divergence #370 documented rather
 * than a new one, no fixture can see it (neither `Profile` nor `Cover` has the
 * column), and it is specific to *this* path: on a many-to-one both clients
 * issue the update and both stamp.
 *
 * **Why a `create` reads nothing.** There is no row yet, so there is no self to
 * be the incumbent and no `where` to read one through.
 *
 * **Why an absent parent detaches nothing, which is belt and braces and is
 * kept anyway.** Prisma *does* detach and then rolls the whole thing back —
 * measured on `update({ where: { id: 99 } })`, which logs the
 * `update … set userId = null`, then `ROLLBACK`, then answers P2025. gemi
 * reaches the same committed state by the same route, because `update` raises
 * `RecordNotFoundError` on a `where` that matches nothing and every plan
 * carrying a step runs in a transaction — verified by dropping this return and
 * watching `O12g` stay green. So it buys no correctness today; it buys two
 * statements on a miss, and it makes this step's effect independent of whether
 * the statement *after* it raises, which is the assumption that would be
 * expensive to have baked in silently if that ever changed.
 */
async function displaceSibling(
  schema: ModelSchema,
  fkFields: readonly string[],
  /**
   * The values about to be written into this row's foreign key, positionally
   * paired with `fkFields`.
   *
   * **A key with a null component displaces nothing**, which is the composite
   * generalisation of the `value === null` return this has always had rather
   * than a new rule: the row is being *un*linked, and there is no incumbent for
   * a link that is not being made. See {@link isLinked}.
   */
  values: readonly unknown[],
  /**
   * This statement's own `where`, **already through this model's policies** —
   * which is what {@link readOwnKey} below is documented to expect, and the
   * reason it is the same call the `disconnect` filter arm and `upsert` make.
   */
  where: unknown,
  /** False on a `create`, where the row does not exist yet. */
  existing: boolean,
  executor: RelationExecutor,
): Promise<void> {
  if (!isLinked(values)) return;

  if (existing) {
    const self = await readOwnKey(schema.name, fkFields, where, executor);

    if (self === null || self === undefined) return;
    // **Every column, not the first that differs** — the skip is "this row
    // already points at that row", and on a composite key that is only true
    // when the whole tuple matches. Reading it as "some column matches" would
    // skip the clear for a sibling holding `(1, "b")` while this row takes
    // `(1, "a")`, and the repoint would then collide on the unique index the
    // caller cannot see.
    if (fkFields.every((field, index) => sameKey(self[field], values[index]))) {
      return;
    }
  }

  await clearLinks(schema.name, fkFields, values, executor);
}

/**
 * Whether two foreign-key values name the same row.
 *
 * Not `===`, because the two operands reach this from different places and a
 * key type can survive the trip differently. One side is read out of the
 * database through a `select`; the other is either a caller's literal — `connect:
 * { id: 2 }`, taken straight from the argument tree by the direct form — or a
 * value read back off the far model. A `BigInt` key is the case that makes this
 * concrete rather than theoretical: `2n === 2` is `false`, and answering "these
 * are different rows" there is what would make the clear fire on the row it is
 * meant to skip.
 *
 * The fallback is deliberately loose in the other direction too — it calls the
 * number `2` and the string `"2"` the same row. Harmless for every key type in
 * reach: Prisma's unique keys are `Int`, `BigInt`, `String`, `Bytes` and the
 * date types, and a `String` key whose value is `"2"` can only be compared
 * against another `String`, since the column it came from decides both sides.
 * Stated rather than tightened, because the tightening would have to know the
 * field's type here and the looseness has no reachable victim.
 */
function sameKey(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return a === b || String(a) === String(b);
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
 * A to-one `disconnect` / `delete` operand, **as the caller spelled it** — a
 * boolean, or a filter object, and nothing else.
 *
 * The counterpart of {@link assertNamedRows}, and deliberately *not* it. That
 * one runs `matchUniqueKey`, which is right where the caller is picking one row
 * out of many and wrong here: Prisma's to-one operand is a `WhereInput`, and
 * `delete: { bio: "seed" }` — a column with no unique index anywhere near it —
 * is accepted and deletes the connected row. Sharing `assertNamedRows` would
 * have refused that at compile time with a list of unique keys the caller never
 * had to name.
 *
 * **Run before {@link toOneOperand} rather than after it, which is what makes
 * `null` reachable at all.** That translation maps `false` to `null`, so a
 * check downstream of it sees one value for two very different calls: the
 * deliberate no-op, and an operand of a type Prisma has no arm for. This used
 * to sit downstream and pass both, and the second is the one that mattered —
 * before #359 the owning side refused everything but `true`, so `disconnect:
 * null` was an `UnsupportedQueryError` there, and widening the grammar turned a
 * refusal into silence. That is the failure class the differential suite exists
 * to pin, arrived at from the tidy direction, and it is not one to inherit on
 * the strength of the far side having it too.
 *
 * Measured, so the refusal is matching Prisma rather than being stricter than
 * it (6.19.2, SQLite): `disconnect: null` is a `PrismaClientValidationError` on
 * all three shapes it can be written against — a one-to-one from either end and
 * a many-to-one — with nothing written. `undefined` is the *absent* key and
 * stays a no-op on both clients, which is why only `null` is named here:
 * `canonicalShape` drops an undefined member outright, so `disconnect:
 * undefined` and no `disconnect` at all are already one call.
 *
 * Sound at plan time for the same reason the boolean guard is (#358):
 * `canonicalShape` records `null` as `"null"`, the booleans as `"true"` /
 * `"false"` and a filter by its structure, so no two of them can share a cache
 * entry and this refusal can never be decided on one call's behalf by another's.
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
  if (operand === undefined) return;
  if (typeof operand === "boolean") return;
  if (operand !== null && typeof operand === "object" && !Array.isArray(operand)) {
    return;
  }

  throw new InvalidArgumentError(
    `data.${relation.name}.${key}`,
    schema.name,
    operation,
    `'${relation.name}' is a to-one, so '${key}' takes either a boolean — ` +
      `'true' for the connected ${child.name}, 'false' for nothing — or an ` +
      `object of filters it has to match. Prisma's operand here is ` +
      `'${child.name}WhereInput | boolean'.` +
      // Named rather than left to the list above, because `null` is the one
      // wrong value with an obvious intent: it is what an optional flag
      // degrades to, and `false` is the spelling that means what it was
      // reaching for. Prisma refuses it too, so pointing at `false` is a
      // correction and not a workaround.
      (operand === null
        ? ` 'null' is not one of them — write 'false' for the no-op. Prisma ` +
          `answers 'null' with a validation error rather than accepting it.`
        : ""),
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

  assertFilterFields(child, record.where);
}

/** The keys of a `where` that are not columns. Mirrors `compileWhere`'s. */
const FILTER_COMBINATORS: ReadonlySet<string> = new Set([
  "AND",
  "OR",
  "NOT",
  COMPOSITE_IN,
]);

/**
 * Every column a to-one operand's `where` names, checked against the child at
 * **plan** time rather than when a row happens to be there.
 *
 * Both operands compile that filter only on the branch that has a linked row to
 * apply it to — `update` throws `RecordNotFoundError` before it looks, `upsert`
 * takes the create branch — so a typo was a query that succeeded or failed
 * depending on the data:
 *
 *     User.update({ where: { id: 2 }, data: { organization: { upsert: {
 *       where: { naem: "Acme" }, create: { … }, update: { … } } } } })
 *
 * against a user with no organization created it with the filter silently
 * dropped, and against a user who had one raised `UnknownFieldError` from
 * `Organization.findFirst`. Same query, two answers, and the failing one only
 * appears once production data changes shape. Prisma refuses the unknown
 * argument in both cases.
 *
 * `UnknownFieldError` deliberately, and with the child's own field list: it is
 * the error {@link compileWhere} raises one layer down, so the two paths are now
 * indistinguishable rather than merely both-failing. The check mirrors that
 * function's dispatch — a key is a combinator, a relation, a field, or Prisma's
 * `a_b` spelling of a composite `@@unique` — and stops at the top level of each
 * group, because everything below it is an operator whose grammar the field's
 * own filter owns.
 */
function assertFilterFields(child: ModelSchema, filter: unknown): void {
  if (filter === null || typeof filter !== "object") return;

  if (Array.isArray(filter)) {
    for (const one of filter) assertFilterFields(child, one);
    return;
  }

  const record = filter as Record<string, unknown>;

  for (const name of Object.keys(record)) {
    if (record[name] === undefined) continue;

    if (FILTER_COMBINATORS.has(name)) {
      assertFilterFields(child, record[name]);
      continue;
    }

    if (name in child.fields || name in child.relations) continue;
    if (child.uniques.some((unique) => unique.join("_") === name)) continue;

    throw new UnknownFieldError(name, child.name, Object.keys(child.fields));
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
 *
 * **Every column of the link, and the first required one is named** (#271).
 * Prisma makes a composite relation optional or required as a whole — it
 * refuses a mixture, *"The fields of a relation must either all be optional or
 * all be required"* — so on a schema Prisma accepted the columns agree and any
 * one of them answers. Checking all of them anyway costs nothing and means the
 * refusal does not depend on a validation rule enforced in another program:
 * a hand-built `ModelSchema` with a nullable `tenantId` beside a required
 * `ledgerCode` is refused here rather than nulling half a key.
 *
 * That is a claim about behaviour, so it is measured rather than asserted —
 * `ledgerSealMixed` in `fixtures.ts` is exactly that schema, and
 * `composite-relations.test.ts` names the column this refuses on. **The
 * nullable column is first there deliberately**: `[fieldNames[0]]` is what this
 * collapses to if the generalisation is undone, and over `(nullable, required)`
 * that answers *"detachable"*. The same fixture pins the two `displaces`
 * predicates, which generalised the same way and were equally unpinned.
 */
function assertDisconnectable(
  owner: ModelSchema,
  relation: RelationSchema,
  fieldNames: readonly string[],
  caller: RefusalOrigin,
): void {
  const required = fieldNames.find((name) => !owner.fields[name]?.nullable);
  if (required === undefined) return;

  throw new UnsupportedQueryError(
    caller.argument,
    caller.model,
    caller.operation,
    `'${owner.name}.${required}' is required, so there is no value to leave ` +
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
