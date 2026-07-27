import { DatabaseManager } from "../database/DatabaseManager";
import { app } from "../foundation/app";
import { dialectFor } from "./dialect";
import { MissingModelSchemaError, RecordNotFoundError } from "./errors";
import { getOrCompile, type Operation, type QueryPlan } from "./plan";
import type { ModelSchema } from "./schema";

/**
 * The base every generated model class extends.
 *
 * `$exec` is the framework's single choke point: it is the only place in the
 * ORM that touches the database, and the twelve public operations on the
 * generated subclasses are one-line delegations to it. Nested relation reads
 * will recurse through it too. Everything cross-cutting hangs here — the plan
 * cache today, ambient transactions in iteration 5, policies in iteration 6,
 * plus slow-query logging and metrics later. One operation that "just does a
 * quick insert directly" silently escapes all of it, which is why there is
 * exactly one door.
 *
 * Framework internals take a `$` prefix so they cannot collide with anything an
 * application author adds to a model.
 */
const ORTHROW = new Set(["findFirstOrThrow", "findUniqueOrThrow"]);

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

    // `unsafe` despite the name. Bun's tagged template cannot express a query
    // whose *shape* is dynamic, which every ORM query is. Safety here does not
    // come from the template syntax: it comes from the compiler's two rules —
    // identifiers only ever come from the generated schema, and every value is
    // a bound parameter. Do not "fix" this into a tagged template.
    const rows = await db.sql.unsafe(plan.text, plan.bind(args));

    const result = this.$shape(plan, rows as unknown[]);

    // The plan shapes a single-row read to `null` when nothing matched; turning
    // that into an error belongs here rather than in the plan, because this is
    // where the model's name is in scope for the message.
    if (result === null && ORTHROW.has(op)) {
      throw new RecordNotFoundError(schema.name, op);
    }

    return result;
  }

  /**
   * A static, not a module-level function, so subclassing is the extension
   * mechanism: a future `ActiveRecordModel` overrides this to build instances,
   * and every model extending it gets that with no change to the twelve
   * operations. It is also where iteration 8 populates row provenance.
   */
  static $shape(plan: QueryPlan, rows: unknown[]): unknown {
    return plan.shape(rows);
  }
}
