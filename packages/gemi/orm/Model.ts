import { DatabaseManager } from "../database/DatabaseManager";
import { app } from "../foundation/app";
import { type BindContext, createBindContext } from "./compile/fragment";
import {
  type NestedWriteStep,
  type RelationExecutor,
  attachRelations,
} from "./compile/plan-relations";
import { dialectFor, type SqlDialect } from "./dialect";
import {
  MissingModelSchemaError,
  RecordNotFoundError,
  UniqueConstraintError,
} from "./errors";
import { getOrCompile, type Operation, type QueryPlan } from "./plan";
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

  static $modelSchema(): ModelSchema {
    const schema = this.$schema;
    if (!schema) throw new MissingModelSchemaError(this.name);
    return schema;
  }

  static async $exec(op: Operation, args: any = {}): Promise<unknown> {
    const schema = this.$modelSchema();

    // Resolved per call, never captured at module scope: that is what keeps the
    // connection swappable in tests, and it is the hook iteration 5 uses to
    // pick up an ambient transaction instead of the pooled connection.
    const db = app(DatabaseManager);
    const dialect = dialectFor(db.dialect);

    const plan = getOrCompile(schema, op, args, dialect);

    const executor: RelationExecutor = {
      exec: (model, operation, relationArgs) =>
        registry
          .get<typeof Model>(model)
          .$exec(operation as Operation, relationArgs),
      query: (text, values) => db.sql.unsafe(text, values),
    };

    // One context per call, holding the instant every `now()` and `@updatedAt`
    // on this operation shares, plus whatever the `before` steps resolve.
    const context = createBindContext();

    // NOT ATOMIC until iteration 5. A write with nested `create`/`connect` runs
    // more than one statement, and there is no transaction around them: if a
    // later step fails, the earlier rows stay written. This is a recorded
    // decision — iteration 5 introduces the ambient-transaction ALS here and
    // makes all of it atomic without changing the call sites.
    await runSteps(plan.before, args, context, executor, []);

    // `unsafe` despite the name. Bun's tagged template cannot express a query
    // whose *shape* is dynamic, which every ORM query is. Safety here does not
    // come from the template syntax: it comes from the compiler's two rules —
    // identifiers only ever come from the generated schema, and every value is
    // a bound parameter. Do not "fix" this into a tagged template.
    const rows = await execute(
      db,
      dialect,
      schema,
      op,
      plan.text,
      plan.bind(args, context),
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
    await runSteps(plan.after, args, context, executor, rowsOf(result));

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
        args,
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
  // Sequentially, for the same reason relations load sequentially: iteration 5
  // puts an ambient transaction on a single reserved connection, where
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
  db: { sql: { unsafe(text: string, values: unknown[]): unknown } },
  dialect: SqlDialect,
  schema: ModelSchema,
  op: Operation,
  text: string,
  values: unknown[],
): Promise<unknown> {
  try {
    return await db.sql.unsafe(text, values);
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
