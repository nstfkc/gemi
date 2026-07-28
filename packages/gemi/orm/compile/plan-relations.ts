import type { SqlDialect } from "../dialect";
import {
  MalformedRelationError,
  MissingModelSchemaError,
  RelationDepthExceededError,
  UnknownRelationError,
  UnregisteredRelationTargetError,
  UnsupportedQueryError,
} from "../errors";
import { assertPageArgument } from "./paginate";
import { COUNT_KEY } from "../relation-filters";
import * as registry from "../registry";
import type { FieldSchema, ModelSchema, RelationSchema } from "../schema";
import {
  type BindContext,
  type Fragment,
  concat,
  createBindContext,
  render,
  sql,
} from "./fragment";
import { resolveSelection } from "./select";

/**
 * The relation planner: an include tree plus a root model in, a *strategy* out.
 *
 * Three strategies exist and the right one is dialect- and query-dependent
 * (invariant 4): batched separate queries, a plain `JOIN`, and `LATERAL` +
 * `json_agg`. This file implements exactly one — batching — but the seam is the
 * point: iteration 7's lateral form has to be a sibling `RelationStrategy`, not
 * a rewrite of everything that reads relations.
 *
 * The strategy interface is deliberately narrow: given a parent schema and one
 * relation node, produce (a) the parent field the stitch keys on, and (b) a
 * `load` that fetches the children and attaches them to the parent rows. What
 * SQL that takes, and how many statements, is entirely the strategy's business.
 */

/**
 * The keys a relation node accepts, which differ by kind. `take` / `skip` are
 * a to-many's alone — on a to-one Prisma rejects them outright, since there is
 * at most one row to page.
 *
 * Prisma's to-one include argument is `{ where?, select?, include? }` — it
 * takes a `where` (verified: it filters, and the relation comes back `null`
 * when nothing matches) but not an `orderBy`, since there is at most one row.
 */
const RELATION_ARGS = new Set([
  "where",
  "orderBy",
  "select",
  "include",
  "take",
  "skip",
]);
const TO_ONE_ARGS = new Set(["where", "select", "include"]);

/**
 * How deep an include tree may nest. Not a modelling limit — a legal tree can
 * be arbitrarily deep and this is far past anything hand-written — but a guard
 * against an argument tree that was generated or forwarded from a request.
 */
export const MAX_RELATION_DEPTH = 10;

type Row = Record<string, unknown>;

/**
 * The registry hands back model *classes*; planning only ever needs the schema
 * off them. Typed structurally rather than by importing `Model`, which would
 * make `compile/` depend on the class it is compiled for.
 */
interface RelatedModel {
  $schema?: ModelSchema;
}

/**
 * Everything a loaded relation needs from the outside world, handed in by the
 * caller rather than reached for.
 *
 * This is what keeps `compile/` a pure schema-in / SQL-out directory: without
 * it, planning a relation would put `DatabaseManager` — and so `import { SQL }
 * from "bun"` — on the load path of every compiler unit test, which is a real
 * cost and not a theoretical one. It also means the m-n join hop runs on
 * whatever connection `$exec` resolved, so iteration 5's ambient transaction
 * will cover both hops of a many-to-many read rather than only the second.
 */
export interface RelationExecutor {
  /**
   * An operation on another model, through *that model's own* `$exec`
   * (invariant 1). Named rather than passed as a class so resolution stays at
   * call time (invariant 6).
   *
   * `preScoped` says whether the target model's policies have **already** been
   * applied to `args`, and every call site has to answer it. Required rather
   * than defaulted, because the two callers need opposite answers and the wrong
   * one is silent in both directions:
   *
   * - A **relation read** from an include tree is pre-scoped: `applyNestedPolicies`
   *   walked the tree before the plan key was computed. Re-applying would `AND`
   *   the same predicate twice — same rows, different SQL, a second plan-cache
   *   entry.
   * - A **nested write** step is not. `data: { notes: { create: … } }` is never
   *   visited by that walk, so the child's policies have not run. Marking it
   *   pre-scoped skipped them entirely: a nested `create` wrote a row with the
   *   scoped column unset, and a nested `connect` resolved its lookup against
   *   every tenant's rows.
   *
   * Defaulting it either way would have made one of those the quiet case. It is
   * the fourth parameter in this codebase to be made required for that reason.
   */
  exec(
    model: string,
    op: string,
    args: unknown,
    preScoped: boolean,
  ): Promise<unknown>;
  /**
   * A statement with no model behind it. Exactly one query in the ORM is like
   * this: Prisma's implicit many-to-many join table, which has no model, no
   * fields of its own and nothing an application could scope.
   */
  query(text: string, values: unknown[]): Promise<unknown>;
}

/** One relation as it appears in an `include` / `select` argument tree. */
export interface RelationNode {
  /** The key on the parent's output object. */
  as: string;
  relation: RelationSchema;
  /** `true`, or the node's own `{ where, orderBy, select, include }`. */
  node: unknown;
  /**
   * Re-locates this node inside the caller's argument tree at run time. The
   * plan is compiled once per argument *shape* and reused across calls, so the
   * node's `where` *values* have to be read from the call, never captured here.
   */
  locate: (args: any) => any;
}

export interface RelationRequest {
  parent: ModelSchema;
  child: ModelSchema;
  relation: RelationSchema;
  as: string;
  node: unknown;
  locate: (args: any) => any;
  dialect: SqlDialect;
  operation: string;
}

/**
 * One nested write, planned once per argument shape and run per call.
 *
 * `before` steps run ahead of the main statement and put foreign keys into the
 * bind context — that is the `data: { user: { connect: ... } }` direction, where
 * this model holds the key. `after` steps run once the row exists and write the
 * far side — the `data: { accounts: { create: ... } }` direction, where the
 * child holds the key and cannot be written until the parent has one.
 *
 * NOT ATOMIC in iteration 4. A nested write is the first single logical
 * operation in this ORM that issues more than one statement, and there is no
 * transaction around them yet: if an `after` step fails, the parent row stays
 * written. This is a recorded decision rather than an oversight — iteration 5
 * introduces the ambient-transaction ALS at the `$exec` choke point and makes
 * every one of these atomic without changing a line here. Building an interim
 * mechanism now would be work iteration 5 deletes.
 */
export interface NestedWriteStep {
  /** The relation field this step was planned for. Named in errors. */
  relation: string;
  /**
   * The Prisma nested-write key this step implements. Two steps on the same
   * relation can produce byte-identical SQL and differ only in what the step
   * itself does, so this is what makes a plan legible from the outside: to a
   * test, and to whatever logs queries later.
   */
  operation: "connect" | "create" | "createMany";
  run(
    args: any,
    context: BindContext,
    executor: RelationExecutor,
    /** The rows the main statement returned. Empty for a `before` step. */
    rows: readonly Row[],
  ): Promise<void>;
}

export interface RelationPlan {
  /** The key this relation is written to on each parent row. */
  as: string;
  /**
   * The related model's *name*, for anything above the compiler that has to
   * reach the child's own policies — resolved through the registry at call
   * time, never imported (invariant 6).
   *
   * `Model.$exec` needs it for exactly one thing: redacting a relation the
   * strategy **folded**. A batched child is shaped by its own `$exec` and
   * redacts itself; a folded one never enters that call, so the parent has to
   * run the child's `redact` on its behalf — and it cannot do that without
   * knowing whose rows they are.
   */
  model: string;
  kind: "one" | "many";
  /**
   * The parent *fields* whose values key the stitch. The root query must select
   * every one of them even when the caller's `select` did not ask for it.
   *
   * A list because a relation may join on more than one field; for the ordinary
   * single-field case it holds one.
   */
  parentFields: string[];
  /** Which strategy produced this plan. Reported by tests and, later, metrics. */
  strategy: string;
  /** Fetches the children for these parents and attaches them in place. */
  load(parents: Row[], args: any, executor: RelationExecutor): Promise<void>;
  /**
   * SQL this relation contributes to the **root** statement, for a strategy that
   * folds children in rather than fetching them separately.
   *
   * Absent for the batched strategy, whose `load` runs afterwards — and absent is
   * the common case, so the compiler's fast path is one `undefined` check.
   *
   * **Why this exists, since it is a widening of a seam that claimed not to need
   * one.** Iteration 3 built the planner as a swappable stage and invariant 4
   * lists three strategies, two of which are single-round-trip. But a strategy's
   * entire output was a `load()` that runs after the root query plus the field
   * names the root must select for stitching — no way to add a column expression,
   * a join, or a table alias, which is all three of the things a lateral join
   * needs. The seam was swappable for "fetch children separately, by some means"
   * and closed to "fold children into the root statement".
   *
   * Additive on purpose: `batchedStrategy` does not set it and is unchanged, so
   * the widening cannot regress the strategy that ships. See
   * `plans/orm/09-lateral-strategy.md`.
   */
  root?: RootContribution;
}

/**
 * One relation a fold pulled in *below* the node itself, and what it pulled in
 * turn.
 *
 * A folded tree is one statement, so nothing below the root ever reaches the
 * related model's own `$exec` — and `redact` is the one policy capability that
 * cannot ride along in the argument tree, because it is a row transform rather
 * than a `where`. The parent runs it on the whole subtree's behalf, and it
 * cannot do that without knowing the shape of what was folded. Depth-1 alone
 * would leave a grandchild's redaction silently unapplied, which is the failure
 * mode worth naming.
 */
export interface FoldedRelation {
  as: string;
  /** The related model's *name*, resolved through the registry at call time. */
  model: string;
  kind: "one" | "many";
  /** What this relation folded in turn. Empty for a leaf. */
  folded: FoldedRelation[];
}

/**
 * What a fold-into-the-root strategy adds to the root statement.
 *
 * Fragments rather than strings, like everything else the compiler emits, so a
 * contributed subquery binds its values as parameters and cannot smuggle one into
 * the SQL text — invariant 2 applies to a strategy's SQL exactly as it does to
 * the compiler's own.
 */
export interface RootContribution {
  /** Appended to the root select list. Must alias to the relation's `as`. */
  column: Fragment;
  /** Appended after the `from` clause — a `left join lateral (…) on true`. */
  join: Fragment;
  /**
   * The relations this one folded below itself. Empty when the node is a leaf,
   * which is the common case.
   */
  folded: FoldedRelation[];
  /**
   * Turns the column's raw value into the shaped relation.
   *
   * Separate from the column so the shaper stays a pure function of the row:
   * `json_agg` returns *text*, so this is where dates stop being strings and an
   * empty to-many becomes `[]` rather than `null`.
   */
  decode(value: unknown): unknown;
}

/**
 * The distinct strategies a set of relation plans used, sorted so the value is a
 * stable thing to assert on.
 */
export function strategiesOf(plans: readonly RelationPlan[]): string[] {
  return [...new Set(plans.map((plan) => plan.strategy))].sort();
}

export interface RelationStrategy {
  readonly name: string;
  plan(request: RelationRequest): RelationPlan;
}

export interface RelationPlanning {
  plans: RelationPlan[];
  /** Parent fields the root query must select for stitching to be possible. */
  keyFields: string[];
}

export function planRelations(
  schema: ModelSchema,
  args: any,
  dialect: SqlDialect,
  operation: string,
  strategy: RelationStrategy = batchedStrategy,
): RelationPlanning {
  const nodes = relationNodes(schema, args, operation);
  if (nodes.length === 0) return { plans: [], keyFields: [] };

  const plans: RelationPlan[] = [];
  const keyFields = new Set<string>();

  for (const node of nodes) {
    assertNodeArgs(schema, node, operation);
    const child = resolveSchema(schema, node);

    // Only the first level becomes a plan here: a child query runs through
    // `$exec` on the child's own model class, so its own include tree is
    // compiled by its own call (invariant 1). The *whole* tree is still walked
    // now, because the depth guard is worthless if it only ever sees one level
    // at a time — an unbounded tree would be caught one query too late, every
    // time, forever.
    validateSubtree(child, node.node, operation, 2);

    const plan = strategy.plan({
      parent: schema,
      child,
      relation: node.relation,
      as: node.as,
      node: node.node,
      locate: node.locate,
      dialect,
      operation,
    });

    plans.push(plan);
    for (const field of plan.parentFields) keyFields.add(field);
  }

  return { plans, keyFields: [...keyFields] };
}

/**
 * Runs after the parent rows are shaped: loads every relation node and drops
 * the key columns that were only selected to make stitching possible.
 *
 * One query per **node in the include tree**, not per row. A depth-3 tree with
 * two branches is 5 queries over 100 parents, not 500 — the thing everyone
 * assumes is wrong when they first read the query log. `relations.test.ts`
 * asserts the count, because an accidental N+1 is otherwise invisible until it
 * is in production.
 */
export async function attachRelations(
  relations: readonly RelationPlan[],
  hidden: readonly string[] | undefined,
  result: unknown,
  args: any,
  executor: RelationExecutor,
): Promise<void> {
  const parents: Row[] = Array.isArray(result)
    ? (result as Row[])
    : result === null || result === undefined
      ? []
      : [result as Row];

  if (parents.length === 0) return;

  // Sequentially, not `Promise.all`: sibling relations are independent queries
  // and running them concurrently is a real win on Postgres, but iteration 5
  // puts an ambient transaction on a single reserved connection, where
  // concurrent statements are not safe. Parallelism belongs with iteration 7,
  // which owns performance and can measure it.
  for (const relation of relations) {
    // A relation that contributed to the root statement already has its children
    // in the row — folded in by a lateral join and decoded by the shaper — so
    // there is nothing to fetch. Calling `load` would issue the very query the
    // strategy exists to avoid, and overwrite the correct result with it.
    if (relation.root) continue;
    await relation.load(parents, args, executor);
  }

  if (hidden && hidden.length > 0) {
    // A `select` that omits the join key still has to *fetch* it. Deleting is
    // the price of that, and it is confined to exactly this case: with no
    // `select`, or a `select` that already names the key, `hidden` is empty and
    // this never runs.
    for (const parent of parents) {
      for (const key of hidden) delete parent[key];
    }
  }
}

// --- the include tree ------------------------------------------------------

/**
 * Pulls the relation nodes out of an `include` or a `select`.
 *
 * Prisma allows relations in both, and they mean different things about the
 * *scalars*: `include` keeps them all, `select` keeps only what it names. What
 * they mean about relations is identical, so both funnel through here.
 */
export function relationNodes(
  schema: ModelSchema,
  args: any,
  operation: string,
): RelationNode[] {
  if (args === undefined || args === null) return [];

  const include = args.include;
  const select = args.select;

  assertExclusive(schema, include, select, operation);

  const out: RelationNode[] = [];

  if (include !== undefined && include !== null) {
    if (typeof include !== "object" || Array.isArray(include)) {
      throw new UnsupportedQueryError(
        "include",
        schema.name,
        operation,
        "Expected an object.",
      );
    }

    // Sorted for the same reason `where` is: the plan cache canonicalises key
    // order, so two argument objects differing only in key order are one entry
    // and must therefore produce one plan.
    for (const key of Object.keys(include).sort()) {
      const node = include[key];
      if (node === undefined || node === false) continue;

      // `_count` is a projected subquery rather than a relation node — see
      // `planRelationCounts`. It sits in the same container, so every walk over
      // that container has to step past it.
      if (key === COUNT_KEY) continue;

      const relation = schema.relations[key];
      if (!relation) {
        throw new UnknownRelationError(
          key,
          schema.name,
          Object.keys(schema.relations),
        );
      }

      out.push({
        as: key,
        relation,
        node,
        locate: (args: any) => args?.include?.[key],
      });
    }
    return out;
  }

  if (select !== undefined && select !== null && typeof select === "object") {
    for (const key of Object.keys(select).sort()) {
      const node = (select as Record<string, unknown>)[key];
      if (node === undefined || node === false) continue;

      // A scalar key, or a typo in one — `resolveSelection` owns both, and
      // reports a typo against the field list rather than the relation list.
      const relation = schema.relations[key];
      if (!relation) continue;

      out.push({
        as: key,
        relation,
        node,
        locate: (args: any) => args?.select?.[key],
      });
    }
  }

  return out;
}

/**
 * `select` and `include` are mutually exclusive at *every* level, not only at
 * the root: the result shape would be ambiguous either way.
 */
function assertExclusive(
  schema: ModelSchema,
  include: unknown,
  select: unknown,
  operation: string,
  at?: string,
): void {
  if (include === undefined || select === undefined) return;
  throw new UnsupportedQueryError(
    at ? `${at}: select + include` : "select + include",
    schema.name,
    operation,
    "Prisma allows only one of them on the same query, at any level.",
  );
}

function assertNodeArgs(
  schema: ModelSchema,
  node: RelationNode,
  operation: string,
): void {
  const value = node.node;
  if (value === true) return;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsupportedQueryError(
      node.as,
      schema.name,
      operation,
      "Expected true or an object of relation arguments.",
    );
  }

  const args = value as Record<string, unknown>;
  assertExclusive(schema, args.include, args.select, operation, node.as);

  const many = node.relation.kind === "many";

  for (const key of Object.keys(args).sort()) {
    if (args[key] === undefined) continue;
    if (many && (key === "take" || key === "skip")) {
      assertNodePageArgument(schema, node, operation, key, args[key]);
      continue;
    }
    if (many ? RELATION_ARGS.has(key) : TO_ONE_ARGS.has(key)) continue;

    // A to-one relation is at most one row, so ordering it is meaningless and
    // Prisma rejects it outright — `Unknown argument 'orderBy'`, listing
    // `where?` as one of the options it *does* take. Accepting it here would be
    // a silent superset of Prisma on an argument that cannot mean anything.
    if (key === "orderBy" && !many) {
      throw new UnsupportedQueryError(
        `${node.as}.orderBy`,
        schema.name,
        operation,
        `Prisma does not accept 'orderBy' on a to-one relation — there is at ` +
          `most one row to order.`,
      );
    }

    // A to-one is at most one row, so there is nothing to page and Prisma says
    // so. The to-many case is not refused here at all: whether a per-parent
    // page can be expressed is a property of the *strategy*, not of the
    // argument tree, and `assertPaginable` raises it where that is known.
    if (key === "take" || key === "skip") {
      throw new UnsupportedQueryError(
        `${node.as}.${key}`,
        schema.name,
        operation,
        `Prisma does not accept '${key}' on a to-one relation.`,
      );
    }

    throw new UnsupportedQueryError(
      `${node.as}.${key}`,
      schema.name,
      operation,
    );
  }
}

/**
 * The relation-node spelling of the root check, which lives in `paginate.ts`
 * beside the code that reads these two arguments.
 *
 * One function rather than two with the same body: #84 was the root path *not*
 * having this check, and the fix landing as a second copy is how the two drift
 * — a `take` refused inside an `include` and coerced at the root is a worse
 * story than either rule alone. The only difference is the name reported, and
 * that is a parameter.
 *
 * That is also why the plan key records a `take`'s sign; see `shapeOfMember`.
 */
function assertNodePageArgument(
  schema: ModelSchema,
  node: RelationNode,
  operation: string,
  key: "take" | "skip",
  value: unknown,
): void {
  assertPageArgument(schema.name, operation, `${node.as}.${key}`, key, value);
}

/**
 * Refuses a per-parent `take` / `skip` that the strategy about to plan this node
 * cannot express, naming the one that can.
 *
 * `include: { accounts: { take: 5 } }` means five accounts *per user*, not five
 * overall. The batched strategy serves every parent from one query, so the only
 * `limit` it could emit would page the parents' children as a single set —
 * plausible, and wrong. It refuses instead. The lateral strategy's subquery
 * already runs once per parent row, so a `limit` inside it means exactly what
 * Prisma means, which is why this is the one relation argument whose support is
 * a property of the strategy rather than of the compiler.
 *
 * `why` says what put this node on a strategy that cannot page it — the dialect,
 * a decline, or an explicit `strategy: "batched"` — because that is the part the
 * caller can act on.
 */
export function assertPaginable(request: RelationRequest, why: string): void {
  const node = request.node;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;

  for (const key of ["take", "skip"] as const) {
    if ((node as Record<string, unknown>)[key] === undefined) continue;

    throw new UnsupportedQueryError(
      `${request.as}.${key}`,
      request.parent.name,
      request.operation,
      `A '${key}' inside a to-many relation is per parent, and the batched ` +
        `relation planner serves every parent from one query — so the only ` +
        `limit it could emit would page every parent's children as one set. ` +
        `Only the lateral join strategy can express it, by paginating inside ` +
        `a subquery that already runs once per parent row, and it needs ` +
        `Postgres: ${why}. Load '${request.as}' as its own query, or narrow ` +
        `it with 'where'.`,
    );
  }
}

/**
 * Walks the rest of the tree for the structural rules and the depth guard.
 *
 * Field names go through the same walk, not just structure: without it a typo
 * in a `select` three levels down is an `UnknownFieldError` raised by that
 * model's own compile — which is to say, after two queries have already run.
 * The whole reason this walk exists is that a guard seeing one level at a time
 * catches things a query too late, and that applies to a misspelled column as
 * much as to an unbounded tree.
 */
function validateSubtree(
  schema: ModelSchema,
  node: unknown,
  operation: string,
  depth: number,
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;

  // Validates the scalar keys and rejects unknown ones; the relation keys in a
  // `select` are this function's own business and it skips them.
  if ((node as Record<string, unknown>).select !== undefined) {
    resolveSelection(schema, node, operation);
  }

  const nodes = relationNodes(schema, node, operation);
  if (nodes.length === 0) return;

  if (depth > MAX_RELATION_DEPTH) {
    throw new RelationDepthExceededError(schema.name, MAX_RELATION_DEPTH);
  }

  for (const child of nodes) {
    assertNodeArgs(schema, child, operation);
    validateSubtree(
      resolveSchema(schema, child),
      child.node,
      operation,
      depth + 1,
    );
  }
}

// --- topology --------------------------------------------------------------

export interface Link {
  /**
   * Fields on the parent whose values the child is matched against, paired
   * positionally with {@link childFields}.
   *
   * **A list, because a relation may join on more than one field.**
   * `@relation(fields: [tenantId, orderId], references: [tenantId, id])` is a
   * deliberate schema style — every table carries the tenant — and it used to
   * be refused on every surface. The pairing is positional and Prisma
   * guarantees the two sides are the same length, which `resolveLink` checks
   * rather than assumes.
   *
   * Singular access is a *narrowing* and has to be justified: nested writes
   * still take one field at a time, so they go through {@link singleFieldLink},
   * which refuses a composite relation by name. That is a type-level guard
   * rather than a convention — there is no `parentField` to reach for.
   */
  parentFields: string[];
  /** Fields on the child holding the matching values. */
  childFields: string[];
  /** Set for Prisma's implicit many-to-many, which joins through a table. */
  join?: { table: string; parentColumn: string; childColumn: string };
}

/**
 * The one-field view of a link, for the callers that genuinely cannot take more.
 *
 * A nested write contributes a *column* to an insert, so a composite relation
 * would be several — a different piece of work from reading across one, and
 * refused here rather than silently writing the first field. #67's acceptance
 * list is the read surfaces; this keeps the write side honest about the gap.
 */
export function singleFieldLink(
  link: Link,
  parent: ModelSchema,
  relation: RelationSchema,
  operation: string,
): { parentField: string; childField: string; join?: Link["join"] } {
  if (link.parentFields.length !== 1) {
    throw new UnsupportedQueryError(
      relation.name,
      parent.name,
      operation,
      `${relation.name} joins on ${link.parentFields.length} fields ` +
        `(${link.parentFields.join(", ")}). Reading across a composite ` +
        `relation works; writing through one would have to contribute that ` +
        `many foreign-key columns to this insert, which is not implemented. ` +
        `Write the child separately with its keys set.`,
    );
  }
  return {
    parentField: link.parentFields[0],
    childField: link.childFields[0],
    join: link.join,
  };
}

/**
 * Which fields on which side actually connect.
 *
 * Only the *owning* side of a relation carries `from` / `to`; the other side
 * carries empty arrays and has to find its counterpart through the shared
 * `relationName`. That is the whole reason `relationName` is in the emitted
 * artifact.
 */
export function resolveLink(
  parent: ModelSchema,
  child: ModelSchema,
  relation: RelationSchema,
  /**
   * The operation the link is being resolved for, so a refusal names where it
   * came from.
   *
   * **Required, and deliberately so.** The bug this argument exists to fix *is*
   * a wrongly-defaulted operation: `single` hardcoded `"include"`, so a
   * composite relation named in a `where` or in a nested `connect` reported a
   * query the caller had not written. A default here would reintroduce exactly
   * that, one call site later — the next surface to correlate over a relation
   * would inherit `include` by omission, silently, and the seven-surface test
   * cannot catch it because it only knows about the seven that exist.
   *
   * It is the fifth parameter in this codebase made required for this reason,
   * after `render`'s `origin`, `changedFields`' `schema` and
   * `RelationExecutor.exec`'s `preScoped`. The rule they share: where omitting
   * an argument silently produces the *wrong* behaviour rather than an error,
   * requiring it is the difference between a convention and something `tsc`
   * enforces.
   */
  operation: string,
): Link {
  if (relation.joinTable) return joinTableLink(parent, child, relation);

  if (relation.from.length > 0) {
    return paired(parent, relation, relation.from, relation.to, operation);
  }

  const other = otherSide(parent, child, relation);
  if (other.from.length === 0) {
    throw new MalformedRelationError(
      parent.name,
      relation.name,
      `neither ${parent.name}.${relation.name} nor ${child.name}.${other.name} ` +
        `holds the foreign key.`,
    );
  }

  // Read from the far side, so `to` is what *this* model holds.
  return paired(parent, relation, other.to, other.from, operation);
}

/**
 * The two sides of a join, checked to line up.
 *
 * Prisma guarantees `fields` and `references` are the same length — it refuses
 * the schema otherwise — so a mismatch here means the generated artifact and
 * the schema disagree, which is a `MalformedRelationError` rather than an
 * unsupported query. Checked rather than assumed because the pairing is
 * positional: a silent length mismatch would join on whichever fields happened
 * to line up.
 */
function paired(
  parent: ModelSchema,
  relation: RelationSchema,
  parentFields: string[],
  childFields: string[],
  operation: string,
): Link {
  if (parentFields.length === 0) {
    throw new UnsupportedQueryError(
      relation.name,
      parent.name,
      operation,
      `${relation.name} names no join fields.`,
    );
  }

  if (parentFields.length !== childFields.length) {
    throw new MalformedRelationError(
      parent.name,
      relation.name,
      `it joins ${parentFields.length} field(s) to ${childFields.length}: ` +
        `${parentFields.join(", ")} against ${childFields.join(", ")}.`,
    );
  }

  return { parentFields, childFields };
}

/** The far end of the relation, found by the name both sides share. */
function otherSide(
  parent: ModelSchema,
  child: ModelSchema,
  relation: RelationSchema,
): RelationSchema {
  const candidates = Object.values(child.relations).filter(
    (candidate) =>
      candidate.relationName === relation.relationName &&
      // A self-relation names the same model on both ends, so the *field* is
      // what distinguishes them.
      !(child.name === parent.name && candidate.name === relation.name),
  );

  if (candidates.length !== 1) {
    throw new MalformedRelationError(
      parent.name,
      relation.name,
      candidates.length === 0
        ? `${child.name} declares no relation named '${relation.relationName}'.`
        : `${child.name} declares ${candidates.length} relations named ` +
            `'${relation.relationName}'.`,
    );
  }

  return candidates[0];
}

/**
 * Multi-field relations — `@relation(fields: [a, b], references: [c, d])` —
 * refused rather than quietly matching on the first field.
 *
 * **Refused everywhere, which is the property that matters**, and it is a
 * property rather than a coincidence: every surface that correlates over a
 * relation resolves its link through here. `include` under either strategy, a
 * relation filter, a `_count`, an `orderBy` through a relation, and every
 * nested write all arrive at this function, so none of them can reach a
 * one-field assumption. There is a test walking all seven.
 *
 * The `operation` argument exists because they do not all arrive from an
 * `include`, and this used to say so anyway: a composite relation named in a
 * `where` reported `(Order.include)`, and so did a nested `connect` on a
 * `create`. A refusal that misnames where it came from sends the reader to a
 * query they did not write — see #61.
 */

/**
 * Prisma's implicit many-to-many has no join *model*: it is a bare
 * `_RelationName` table with an `A` and a `B` column, each holding one side's
 * id, ordered by the two model names alphabetically.
 */
function joinTableLink(
  parent: ModelSchema,
  child: ModelSchema,
  relation: RelationSchema,
): Link {
  const { table, a, b } = relation.joinTable!;

  if (a === b) {
    // A self-referential implicit m-n puts the same model on both ends, so the
    // model names cannot say which column is which. The generator resolves it
    // by field name — see `RelationSchema.joinTable.ownerColumn`.
    const owner = relation.joinTable!.ownerColumn;
    if (!owner) {
      // An artifact generated before the generator knew the rule. Refusing is
      // honest; guessing would silently reverse the relation.
      throw new UnsupportedQueryError(
        relation.name,
        parent.name,
        "include",
        `${relation.name} is a self-referential implicit many-to-many, and the ` +
          `generated artifact predates support for one. Re-run ` +
          `\`prisma generate\`.`,
      );
    }

    return {
      parentFields: [primaryKey(parent, relation)],
      childFields: [primaryKey(child, relation)],
      join: {
        table,
        parentColumn: owner,
        childColumn: owner === "A" ? "B" : "A",
      },
    };
  }

  if (parent.name !== a && parent.name !== b) {
    throw new MalformedRelationError(
      parent.name,
      relation.name,
      `the join table '${table}' connects ${a} and ${b}, neither of which is ` +
        `${parent.name}.`,
    );
  }

  const parentColumn = parent.name === a ? "A" : "B";

  return {
    parentFields: [primaryKey(parent, relation)],
    childFields: [primaryKey(child, relation)],
    join: {
      table,
      parentColumn,
      childColumn: parentColumn === "A" ? "B" : "A",
    },
  };
}

function primaryKey(schema: ModelSchema, relation: RelationSchema): string {
  if (schema.primaryKey.length !== 1) {
    throw new MalformedRelationError(
      schema.name,
      relation.name,
      `an implicit many-to-many joins on ${schema.name}'s primary key, which ` +
        `has ${schema.primaryKey.length} fields.`,
    );
  }
  return schema.primaryKey[0];
}

function field(
  schema: ModelSchema,
  relation: RelationSchema,
  name: string,
): FieldSchema {
  const found = schema.fields[name];
  if (!found) {
    throw new MalformedRelationError(
      schema.name,
      relation.name,
      `it joins on '${name}', which is not a field on ${schema.name}.`,
    );
  }
  return found;
}

function resolveSchema(parent: ModelSchema, node: RelationNode): ModelSchema {
  return relatedSchema(parent, node.relation, node.as);
}

/**
 * The schema on the far side of a relation, looked up by *name*.
 *
 * Resolved by name at call time, never by import at module load: that is what
 * lets two models reference each other without the generated files forming an
 * import cycle (invariant 6).
 */
export function relatedSchema(
  parent: ModelSchema,
  relation: RelationSchema,
  as: string = relation.name,
): ModelSchema {
  const target = relation.model;

  if (!registry.has(target)) {
    throw new UnregisteredRelationTargetError(
      parent.name,
      as,
      target,
      registry.registeredNames(),
    );
  }

  const schema = registry.get<RelatedModel>(target)?.$schema;
  if (!schema) throw new MissingModelSchemaError(target);
  return schema;
}

// --- the batched strategy --------------------------------------------------

/**
 * One query per relation node: collect the parents' key values, fetch every
 * child in a single `where <key> in (<parent keys>)`, stitch by key.
 *
 * SQLite is in-process, so round trips are nearly free and this is close to
 * optimal there. Postgres over a network is RTT-dominated and the lateral form
 * will beat it; that is iteration 7, and it plugs in here.
 */
const BATCHED = "batched";

export const batchedStrategy: RelationStrategy = {
  name: BATCHED,

  plan(request: RelationRequest): RelationPlan {
    // Before anything else, so that a node this strategy cannot serve fails at
    // compile time rather than returning a page nobody asked for.
    assertPaginable(request, `this query planned with the batched strategy`);

    const link = resolveLink(
      request.parent,
      request.child,
      request.relation,
      request.operation,
    );

    // Resolved at plan time so a stale artifact fails when the query is
    // compiled rather than after the root query has already run. Every joined
    // field is checked, not only the first — a composite relation whose second
    // field is unkeyable would otherwise fail mid-stitch.
    for (const name of link.parentFields) {
      assertKeyable(
        request.parent,
        request.relation,
        field(request.parent, request.relation, name),
      );
    }
    for (const name of link.childFields) {
      assertKeyable(
        request.child,
        request.relation,
        field(request.child, request.relation, name),
      );
    }

    // The join-table hops below encode and decode through the *first* field,
    // which is exact: `_PostToTag` has two columns and `resolveLink` gives a
    // one-element list for it.
    const parentKeyField = field(
      request.parent,
      request.relation,
      link.parentFields[0],
    );
    const childKeyField = field(
      request.child,
      request.relation,
      link.childFields[0],
    );

    const many = request.relation.kind === "many";

    return {
      as: request.as,
      model: request.relation.model,
      kind: request.relation.kind,
      parentFields: link.parentFields,
      strategy: BATCHED,
      load(parents, args, executor) {
        const context = {
          parentKeyField,
          childKeyField,
          many,
          parents,
          args,
          executor,
        };
        return link.join
          ? loadThroughJoinTable(request, link, context)
          : loadDirect(request, link, context);
      },
    };
  },
};

interface LoadContext {
  parentKeyField: FieldSchema;
  childKeyField: FieldSchema;
  many: boolean;
  parents: Row[];
  args: any;
  executor: RelationExecutor;
}

async function loadDirect(
  request: RelationRequest,
  link: Link,
  context: LoadContext,
): Promise<void> {
  const { keys, byKey } = index(context.parents, link.parentFields);
  // Every parent's key is null: nothing can match, and the defaults the shaper
  // already wrote (`null` / `[]`) are the answer.
  if (keys.length === 0) return;

  const node = request.locate(context.args);
  const query = childQuery(node, link.childFields, keys);

  const rows = (await context.executor.exec(
    request.relation.model,
    "findMany",
    query.args,
    // Pre-scoped: `applyNestedPolicies` walked this include tree before the
    // plan key was computed.
    true,
  )) as Row[];

  for (const row of rows) {
    const bucket = byKey.get(
      compositeKey(link.childFields.map((field) => row[field])),
    );
    if (!bucket) continue;
    for (const parent of bucket) attach(parent, request.as, row, context.many);
  }

  if (query.hidden) {
    for (const row of rows) {
      for (const field of link.childFields) delete row[field];
    }
  }
}

/**
 * Implicit many-to-many, in two hops: read the pairs out of the join table,
 * then load the children the pairs name.
 *
 * The first hop is the one place in the ORM that issues SQL outside
 * `Model.$exec`, and it is deliberate rather than a shortcut: `_PostToTag` has
 * no model, no fields of its own and nothing an application could scope — it
 * holds two foreign keys. The hop that reads *rows* still goes through `$exec`
 * on the child's own model class, so a policy on `Tag` applies to
 * `include: { tags: true }` exactly as it would to `Tag.findMany`.
 *
 * It runs on `executor.query` rather than resolving a connection of its own,
 * which is what keeps the two hops on the same one. Iteration 5 should keep it
 * that way: if the ambient transaction is resolved inside `$exec` and this hop
 * reached for `DatabaseManager` directly, a many-to-many read would straddle
 * the transaction boundary — second hop enrolled, first not.
 */
async function loadThroughJoinTable(
  request: RelationRequest,
  link: Link,
  context: LoadContext,
): Promise<void> {
  // A join table has exactly two columns, so this hop is single-field by
  // construction — `resolveLink` returns one-element lists for it, and the
  // `[0]` below is that fact rather than an assumption about relations.
  const { keys, byKey } = index(context.parents, link.parentFields);
  if (keys.length === 0) return;

  const { dialect } = request;
  const join = link.join!;

  const pairs = (await readPairs(
    dialect,
    join,
    keys.map((key) => dialect.encode(key[0], context.parentKeyField)),
    context.executor,
  )) as Row[];

  // Parents keyed by the *child* id they link to, so the second hop can stitch
  // in one pass over its rows. Built once, not searched per row.
  const owners = new Map<string, Row[]>();
  const childKeys: unknown[][] = [];

  for (const pair of pairs) {
    const parentKey = compositeKey([
      dialect.decode(pair[join.parentColumn], context.parentKeyField),
    ]);
    const linked = byKey.get(parentKey);
    if (!linked) continue;

    const childValue = dialect.decode(
      pair[join.childColumn],
      context.childKeyField,
    );
    const childKey = compositeKey([childValue]);

    let bucket = owners.get(childKey);
    if (bucket === undefined) {
      bucket = [];
      owners.set(childKey, bucket);
      childKeys.push([childValue]);
    }
    for (const parent of linked) bucket.push(parent);
  }

  if (childKeys.length === 0) return;

  const node = request.locate(context.args);
  const query = childQuery(node, link.childFields, childKeys);

  const rows = (await context.executor.exec(
    request.relation.model,
    "findMany",
    query.args,
    // Pre-scoped: `applyNestedPolicies` walked this include tree before the
    // plan key was computed.
    true,
  )) as Row[];

  // Iterated in the child query's order rather than the pairs' order, so a
  // relation-level `orderBy` still describes what each parent receives.
  for (const row of rows) {
    const bucket = owners.get(compositeKey([row[link.childFields[0]]]));
    if (!bucket) continue;
    for (const parent of bucket) attach(parent, request.as, row, context.many);
  }

  if (query.hidden) {
    for (const row of rows) delete row[link.childFields[0]];
  }
}

/**
 * `select <A>, <B> from <_Relation> where <parent column> in (...)`.
 *
 * Built through the same `Fragment` machinery as everything else, so the two
 * compiler rules still hold: the identifiers come from the generated schema and
 * every value is a bound parameter. It is assembled per call rather than per
 * plan only because the number of parents — and so the number of placeholders
 * on SQLite — is not known until the parents are in hand.
 */
async function readPairs(
  dialect: SqlDialect,
  join: NonNullable<Link["join"]>,
  values: unknown[],
  executor: RelationExecutor,
): Promise<unknown> {
  const statement = concat(
    sql(
      `select ${dialect.quoteIdent(join.parentColumn)}, ` +
        `${dialect.quoteIdent(join.childColumn)} ` +
        `from ${dialect.quoteIdent(join.table)} where `,
    ),
    dialect.inList(
      dialect.quoteIdent(join.parentColumn),
      false,
      values.length,
      () => values,
    ),
  );

  // The one statement in the ORM whose parameter count is not known until the
  // parents are in hand, so the ceiling here is a real ceiling on *fan-out*: on
  // SQLite a to-many `include` over more than 32 766 parent rows would exceed
  // it. Named rather than left to the driver, like everywhere else.
  const { text, binders } = render(statement, dialect, {
    model: join.table,
    operation: "include",
  });
  // These binders close over `values` and read neither argument, but the
  // signature takes both — so a real context goes in rather than `undefined`.
  // The three call sites that passed one argument were a type error the whole
  // time; `orm/` was outside the tsconfig's `include`, so nothing said so.
  const bindContext = createBindContext();
  return executor.query(
    text,
    binders.map((binder) => binder(undefined, bindContext)),
  );
}

/**
 * The child query's arguments: the caller's own relation arguments, plus the
 * key filter, plus the key itself when a `select` left it out.
 *
 * The `in (<parent keys>)` list is the same mechanism iteration 2 built for
 * `in`, at higher volume — the list length here is the *parent row count*, so
 * it varies with the data rather than with the code. On SQLite each distinct
 * length is its own plan text and the plan cache's LRU bound is what contains
 * it; on Postgres the whole list binds to one parameter, and `planKey` asks the
 * dialect so that one entry serves every length rather than one per parent
 * count. No second mechanism either way.
 */
function childQuery(
  node: unknown,
  childFields: string[],
  keys: unknown[][],
): { args: Record<string, unknown>; hidden: boolean } {
  const relationArgs = (
    node === true || node === null || typeof node !== "object" ? {} : node
  ) as Record<string, unknown>;

  /**
   * One field is an `in`; several are an `OR` of `AND`s.
   *
   * **Written in argument space rather than as a tuple `in`**, which is the
   * decision worth recording. Postgres has `(a, b) in ((…),(…))` and SQLite
   * does not, so emitting it would mean a new dialect method and two spellings
   * of the same predicate. `OR: [{ a: 1, b: 2 }, …]` is one shape both dialects
   * already compile, through the `where` compiler that every other filter goes
   * through — so it inherits the parameter accounting, the plan key and the
   * injection rules instead of needing its own.
   *
   * It costs one placeholder per field per parent, where a tuple `in` would
   * cost the same. `ParameterLimitError` therefore fires proportionally sooner
   * on a composite relation, which is the honest behaviour: the ceiling is on
   * placeholders and a composite key uses more of them.
   */
  const filter =
    childFields.length === 1
      ? { [childFields[0]]: { in: keys.map((key) => key[0]) } }
      : {
          OR: keys.map((key) =>
            Object.fromEntries(
              childFields.map((field, index) => [field, key[index]]),
            ),
          ),
        };
  const args: Record<string, unknown> = {
    where:
      relationArgs.where === undefined
        ? filter
        : { AND: [relationArgs.where, filter] },
  };

  if (relationArgs.orderBy !== undefined) args.orderBy = relationArgs.orderBy;
  if (relationArgs.include !== undefined) args.include = relationArgs.include;

  const select = relationArgs.select as Record<string, unknown> | undefined;
  if (select === undefined) return { args, hidden: false };

  const missing = childFields.filter((field) => select[field] !== true);
  if (missing.length === 0) {
    args.select = select;
    return { args, hidden: false };
  }

  // The stitch key has to come back even when the caller did not ask for it —
  // every field of it. `attachRelations`' counterpart on the parent side
  // deletes them again.
  args.select = { ...select };
  for (const field of missing) {
    (args.select as Record<string, unknown>)[field] = true;
  }
  return { args, hidden: true };
}

/**
 * A map key for a tuple of values that cannot collide with a different tuple.
 *
 * `JSON.stringify` of the *normalised* values, not concatenation: `"a" + "b"`
 * and `"ab" + ""` are the same string, and these are user data. Normalising
 * first is what makes a `Date` and a `Bytes` key work at all, since neither
 * compares by identity — `keyOf` already had to solve that for the single-field
 * case, so this reuses it rather than restating it.
 */
function compositeKey(values: unknown[]): string {
  return JSON.stringify(values.map(keyOf));
}

/**
 * Note that a child row reached by more than one parent is attached to each of
 * them **by reference** — a hundred users in three organizations get three
 * organization objects between them, not a hundred. Prisma builds one object
 * per parent, so this is a deliberate divergence in *identity*: the values are
 * identical and the differential harness sees no difference, but mutating
 * `users[0].organization` would be visible through `users[1].organization`.
 *
 * The alternative is a clone per extra parent, which on a wide to-one include
 * is exactly the copying the batched strategy exists to avoid — and a shallow
 * clone would still alias everything below it, so it would buy less than it
 * looks. Worth revisiting in iteration 8, where row provenance gives a reason
 * to care about identity.
 */
function attach(parent: Row, as: string, row: Row, many: boolean): void {
  if (many) {
    (parent[as] as Row[]).push(row);
    return;
  }
  // The shaper wrote `null`; the first match wins. A to-one cannot legitimately
  // have two matches, and taking the first is what Prisma does with one.
  if (parent[as] === null) parent[as] = row;
}

/**
 * Parents grouped by their key value, built once per child query. The stitch is
 * then one pass over the child rows — never a `find()` per row, which is the
 * quadratic shape this is here to avoid on wide results.
 */
function index(
  parents: Row[],
  on: string[],
): { keys: unknown[][]; byKey: Map<string, Row[]> } {
  const byKey = new Map<string, Row[]>();
  const keys: unknown[][] = [];

  for (const parent of parents) {
    const values = on.map((field) => parent[field]);
    // A null anywhere in the key matches nothing — `in` would not match it
    // either — and the shaper has already written the `null` the caller sees.
    // For a composite key one null is enough: SQL equality on the other fields
    // cannot rescue it.
    if (values.some((value) => value === null || value === undefined)) continue;

    const key = compositeKey(values);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(key, bucket);
      // The raw values, not the map key: these are what get bound into the `in`
      // list, and the dialect's encoder expects the value Prisma would hold.
      keys.push(values);
    }
    bucket.push(parent);
  }

  return { keys, byKey };
}

/**
 * `Map` keys compare by identity for objects, so two `Date`s holding the same
 * instant — or two `Uint8Array`s holding the same bytes — are two different
 * keys. Both sides of a stitch are decoded by the same dialect from the same
 * declared type, so only the decoded shapes that are objects need covering, but
 * they need covering *exhaustively*: a key kind that falls through compares by
 * reference, every lookup misses, and the relation silently stitches to `[]` or
 * `null`. That is the same failure this function exists to prevent, and it is
 * silent in the same way — hence the throw rather than a fallthrough.
 */
function keyOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value.getTime();
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      (value as ArrayBufferView).buffer,
      (value as ArrayBufferView).byteOffset,
      (value as ArrayBufferView).byteLength,
    );
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `bytes:${hex}`;
  }
  // Unreachable: `assertKeyable` refuses a join key whose declared type decodes
  // to any other object at plan time, where the model and field are in scope
  // for the message. Worth asserting rather than falling through to a reference
  // comparison that returns empty relations.
  throw new Error(
    `Cannot key a relation stitch on ${Object.prototype.toString.call(value)}.`,
  );
}

/**
 * Refuses a join key whose values cannot be compared *by value* once decoded.
 *
 * Every scalar Prisma can put in a foreign key compares fine — numbers,
 * strings, bigints, booleans — and `Date` and `Bytes` are normalised by
 * `keyOf`. `Json` is the one that cannot be: it decodes to a fresh object per
 * row, so the two sides of a stitch would never match and the relation would
 * come back empty rather than wrong-looking. Prisma cannot declare such a
 * relation, so this only fires on a hand-edited artifact — which is exactly
 * when a clear message is worth having.
 */
function assertKeyable(
  schema: ModelSchema,
  relation: RelationSchema,
  key: FieldSchema,
): void {
  if (key.type !== "Json") return;
  throw new MalformedRelationError(
    schema.name,
    relation.name,
    `it joins on '${key.name}', a ${key.type} — which decodes to a new object ` +
      `per row and so cannot be compared between the two sides.`,
  );
}
