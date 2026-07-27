import type { SQL } from "bun";
import { DatabaseManager } from "../database/DatabaseManager";
import { app } from "../foundation/app";
import { type BindContext, createBindContext } from "./compile/fragment";
import { currentTransaction, isSystemScope, runAsSystem, withTransaction } from "./context";
import {
  type NestedWriteStep,
  type RelationExecutor,
  attachRelations,
} from "./compile/plan-relations";
import { dialectFor, type SqlDialect } from "./dialect";
import {
  MissingModelSchemaError,
  PolicyDeniedError,
  RecordNotFoundError,
  UniqueConstraintError,
} from "./errors";
import { getOrCompile, type Operation, type QueryPlan } from "./plan";
import {
  applyPolicies,
  applyRedaction,
  currentUser,
  policiesFor,
  type ModelPolicy,
  type PolicyContext,
} from "./policy";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

/**
 * The base every generated model class extends.
 *
 * `$exec` is the framework's single choke point: it is the only place in the
 * ORM that touches the database, and the public operations on the generated
 * subclasses are one-line delegations to it. Nested relation reads and nested
 * writes recurse through it too. Everything cross-cutting hangs here — the plan
 * cache and constraint-error translation today, ambient transactions in
 * iteration 5, policies in iteration 6, plus slow-query logging and metrics
 * later. One operation that "just does a quick insert directly" silently
 * escapes all of it, which is why there is exactly one door.
 *
 * Framework internals take a `$` prefix so they cannot collide with anything an
 * application author adds to a model.
 */

/** Operations Prisma raises on when nothing matched, rather than returning null. */
const ORTHROW = new Set([
  "findFirstOrThrow",
  "findUniqueOrThrow",
  // Prisma raises P2025 — "No record was found for an update" / "...a delete" —
  // rather than returning null, and the differential harness compares the fact
  // of throwing.
  "update",
  "delete",
]);

export abstract class Model {
  /** Assigned by the generated subclass from `app/models/generated/schema.ts`. */
  static $schema: ModelSchema;

  /**
   * The model's own policy. Optional, inherited through the prototype chain so
   * a shared base can contribute one to every subclass — see `policiesFor` for
   * the order, which is base first and narrowing-only.
   */
  static $policy?: ModelPolicy;

  /**
   * Runs `fn` with policies suspended, for code that has no user and knows it:
   * a cron tick, a queue worker, a seed script, a migration.
   *
   * Deliberately a wrapper rather than a flag or a fallback. Under
   * deny-by-default the alternative to writing this is an error, which is the
   * point — unscoped access is a sentence someone typed, never what happens
   * when a user fails to turn up.
   *
   *     await Model.asSystem(() => User.findMany({}))
   */
  static asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return runAsSystem(fn);
  }

  static $modelSchema(): ModelSchema {
    const schema = this.$schema;
    if (!schema) throw new MissingModelSchemaError(this.name);
    return schema;
  }

  /**
   * Runs `fn` inside a transaction. Every ORM query in it — at any call depth,
   * through any number of services, including the nested reads an `include`
   * fans out into — joins it automatically.
   *
   * The callback takes **no argument**, and that is the whole feature. Handing
   * back a `tx` would put it in the signature of every function between here
   * and the query, which is precisely the threading Prisma's `$transaction`
   * forces and this exists to remove. If a raw query genuinely needs the
   * handle, `currentTransaction()` hands it over without putting it in anyone's
   * parameter list.
   *
   * Nesting is a savepoint: an inner failure rolls back to it and leaves the
   * outer transaction usable, so a caller that catches keeps going.
   *
   *     await User.transaction(async () => {
   *       const user = await User.create({ data: { email } })
   *       await audit(user)          // its queries are in the transaction too
   *     })
   */
  static transaction<T>(fn: () => Promise<T>): Promise<T> {
    return withTransaction(app(DatabaseManager).sql, () => fn());
  }

  static async $exec(op: Operation, args: any = {}): Promise<unknown> {
    const schema = this.$modelSchema();

    // Resolved per call, never captured at module scope: that is what keeps the
    // connection swappable in tests.
    const db = app(DatabaseManager);
    const dialect = dialectFor(db.dialect);

    // The ambient-transaction hook, and the entire integration. It is one line
    // — and it covers every operation, every nested write and every relation
    // read — only because invariant 1 held: `$exec` is the single door. An
    // operation that acquired a private path to the database would show up
    // here as a statement silently running outside the transaction, committed
    // while its neighbours roll back.
    const conn = currentTransaction() ?? db.sql;

    // POLICIES, AND THE ORDER MATTERS MORE HERE THAN ANYWHERE ELSE IN THE ORM.
    //
    // Policies rewrite the argument tree, so they change the SQL. They must
    // therefore run *before* `getOrCompile`, which keys the plan cache on those
    // arguments. Reordered — compile first, scope after — two users with the
    // same query shape and different scopes would share one plan, and one of
    // them would run the other's SQL. That is a cross-tenant data leak produced
    // by a caching bug, and it would not look like one.
    //
    // A scope that injects a *value* keeps the same shape for every user, so
    // the plan is still shared and only the bound value differs. That is the
    // desired outcome, not a compromise, and `policy.plan-cache.test.ts` pins
    // both halves: same shape means one plan and different parameters, and a
    // scope whose shape varies by user means a different plan key.
    // `asSystem` suspends the whole hook, not just the no-user check: a script
    // that has said it is a script should not then be scoped to a user that
    // happens to be in the request store.
    const policies = isSystemScope() ? [] : policiesFor(this);
    let policy: PolicyContext | undefined;
    let effective = args;

    if (policies.length > 0) {
      policy = { user: currentUser(), operation: op, model: schema.name };

      // Deny by default. "No user" is not "no policy" — see PolicyDeniedError.
      if (policy.user === null) {
        throw new PolicyDeniedError(schema.name, op, "no-user");
      }

      effective = applyPolicies(policies, policy, args);
    }

    const plan = getOrCompile(schema, op, effective, dialect);

    const executor: RelationExecutor = {
      exec: (model, operation, relationArgs) =>
        registry
          .get<typeof Model>(model)
          .$exec(operation as Operation, relationArgs),
      // The one query with no model behind it — the implicit m-n join table —
      // resolves its connection here rather than reaching for the pool, so it
      // joins the transaction like everything else.
      query: (text, values) => conn.unsafe(text, values),
    };

    // One context per call, holding the instant every `now()` and `@updatedAt`
    // on this operation shares, plus whatever the `before` steps resolve.
    const context = createBindContext();

    // A write with a nested `create` / `connect` runs more than one statement.
    // Atomic exactly when the caller wrapped the call in `Model.transaction` —
    // *not* implicitly. A write does not open its own transaction, because
    // `$exec` cannot know whether it is one step of a larger unit; opening one
    // per call would put a `BEGIN` around every query in the framework and turn
    // a caller's transaction into a nest of savepoints it never asked for.
    // Outside one, a failing later step still leaves the earlier rows written.
    await runSteps(plan.before, effective, context, executor, []);

    // `unsafe` despite the name. Bun's tagged template cannot express a query
    // whose *shape* is dynamic, which every ORM query is. Safety here does not
    // come from the template syntax: it comes from the compiler's two rules —
    // identifiers only ever come from the generated schema, and every value is
    // a bound parameter. Do not "fix" this into a tagged template.
    const rows = await execute(
      conn,
      dialect,
      schema,
      op,
      plan.text,
      plan.bind(effective, context),
    );

    const result = this.$shape(plan, rows as unknown[]);

    // The plan shapes a single-row operation to `null` when nothing matched;
    // turning that into an error belongs here rather than in the plan, because
    // this is where the model's name is in scope for the message.
    if (result === null && ORTHROW.has(op)) {
      throw new RecordNotFoundError(schema.name, op);
    }

    // Rows that could not exist until this one did: the far side of a relation
    // whose foreign key lives on the child. Run before relations are attached,
    // so an `include` on the same call sees what was just written.
    await runSteps(plan.after, effective, context, executor, rowsOf(result));

    // Relations are loaded after the root rows are shaped, one query per node
    // in the include tree. Each of those queries is `$exec` on the *related
    // model's own class*, recursively — not a private helper — so a nested read
    // is subject to everything a top-level read is.
    //
    // The planner is handed the database rather than reaching for it: that is
    // what keeps `compile/` free of a runtime import, and it is why the one
    // query with no model behind it — the implicit m-n join table — still runs
    // on the connection this call resolved.
    if (plan.relations !== undefined) {
      await attachRelations(
        plan.relations,
        plan.hidden,
        result,
        effective,
        executor,
      );
    } else if (plan.hidden !== undefined && plan.hidden.length > 0) {
      // A write can hide a key column without having any relation to attach:
      // a nested `after` step needs the parent's key returned, but the caller's
      // `select` never asked for it.
      for (const row of rowsOf(result)) {
        for (const key of plan.hidden) delete row[key];
      }
    }

    // Redaction last, on the shaped result. After relations, not before: a
    // related row was shaped by its own model's `$exec` and has already been
    // through its own policy's `redact` — this one only owns its own rows.
    if (policy) applyRedaction(policies, policy, result);

    return result;
  }

  /**
   * A static, not a module-level function, so subclassing is the extension
   * mechanism: a future `ActiveRecordModel` overrides this to build instances,
   * and every model extending it gets that with no change to the operations. It
   * is also where iteration 8 populates row provenance.
   */
  static $shape(plan: QueryPlan, rows: unknown[]): unknown {
    return plan.shape(rows);
  }
}

async function runSteps(
  steps: NestedWriteStep[] | undefined,
  args: any,
  context: BindContext,
  executor: RelationExecutor,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (steps === undefined) return;
  // Sequentially, for the same reason relations load sequentially: inside an
  // ambient transaction every statement runs on one reserved connection, where
  // concurrent statements are not safe.
  for (const step of steps) {
    await step.run(args, context, executor, rows);
  }
}

/**
 * Runs the statement and translates the failures that have a typed home.
 *
 * A unique violation is the one every application branches on, and every driver
 * reports it differently — SQLite as a message with a code, Postgres as a
 * SQLSTATE with a constraint name. Asking the dialect keeps that difference
 * behind the same seam as everything else, and turning it into an error that
 * names *fields* rather than columns is what makes it useful to a caller that
 * has never seen the database's names.
 */
async function execute(
  conn: Pick<SQL, "unsafe">,
  dialect: SqlDialect,
  schema: ModelSchema,
  op: Operation,
  text: string,
  values: unknown[],
): Promise<unknown> {
  try {
    return await conn.unsafe(text, values);
  } catch (error) {
    const violation = dialect.constraintViolation(error);
    if (!violation) throw error;

    throw new UniqueConstraintError(
      schema.name,
      op,
      fieldsForColumns(schema, violation.columns),
      violation.constraint,
      { cause: error },
    );
  }
}

/**
 * Driver column names back to Prisma field names, so the error reads in the
 * caller's vocabulary. A column with no matching field is reported as-is rather
 * than dropped: it is still the truest thing we know about the failure.
 */
function fieldsForColumns(
  schema: ModelSchema,
  columns: readonly string[],
): string[] {
  return columns.map((column) => {
    for (const field of Object.values(schema.fields)) {
      if (field.column === column) return field.name;
    }
    return column;
  });
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [];
  return [result as Record<string, unknown>];
}
