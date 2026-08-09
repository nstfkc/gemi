import type { SQL, TransactionSQL } from "bun";
import type { DatabaseConnection } from "../database/Connection";
import { DatabaseManager } from "../database/DatabaseManager";
import { app } from "../foundation/app";
import { type BindContext, createBindContext } from "./compile/fragment";
import {
  currentConnectionName,
  currentTransaction,
  isSystemScope,
  runAsSystem,
  runAsUser,
  runOnConnection,
  withTransaction,
} from "./context";
import {
  type FoldedRelation,
  type NestedWriteStep,
  type RelationExecutor,
  type RelationStrategy,
  attachRelations,
} from "./compile/plan-relations";
import { resolveStrategy } from "./compile/strategy";
import { matchUniqueKey } from "./compile/unique";
import { upsertAbsentConflictKey } from "./compile/write";
import { dialectFor, type SqlDialect } from "./dialect";
import { clockCouldSkew, createProtocolSkewWarner } from "./protocol-skew";
import {
  MissingModelSchemaError,
  RecordNotFoundError,
  UnsupportedQueryError,
  UniqueConstraintError,
  ParameterLimitError,
  UnregisteredPolicyClassError,
} from "./errors";
import {
  getOrCompile,
  type ExecOptions,
  type Operation,
  type QueryPlan,
} from "./plan";
import {
  applyNestedPolicies,
  applyPolicies,
  applyRedaction,
  currentUser,
  isPreScoped,
  markOrmAuthored,
  markPreScoped,
  markRedactedAs,
  ormAuthoredFields,
  policiesFor,
  policyContext,
  redactedAs,
  type PolicyEntry,
  type PolicyContext,
} from "./policy";
import {
  changedFields,
  provenanceOf,
  resnapshot,
  track,
  untracked,
} from "./provenance";
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

/**
 * `withTransaction` with the connection's configured warning threshold attached.
 *
 * Every transaction the ORM opens goes through here rather than calling
 * `withTransaction` directly, so `database.slowTransactionThreshold` is read in
 * one place instead of at each call site — and a call site added later cannot
 * quietly open a transaction that ignores the setting. `withTransaction` itself
 * takes the threshold as an argument on purpose; it knows nothing about the
 * container, and this is the seam where the two meet.
 *
 * The same argument now carries the connection's **name**: a pool cannot be
 * asked which one it is, and `withTransaction` has to know in order to tell a
 * nested transaction on the same connection (a savepoint) from one on another
 * (a refusal). Taking the whole connection rather than the manager is what
 * makes both come from the same object, so a named connection cannot end up
 * with the default's threshold.
 */
function transact<T>(
  connection: DatabaseConnection,
  fn: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  return withTransaction(connection.sql, fn, {
    slowTransactionThreshold: connection.config.slowTransactionThreshold,
    connection: connection.name,
  });
}

/**
 * The classes `Model.on` has already built, keyed by the class it was called on
 * and then by connection name.
 *
 * `User.on("analytics")` is a per-query call, so it can happen in a loop and in
 * a hot path; minting a class each time would allocate one per query and defeat
 * every identity comparison downstream — the policy-divergence guard's
 * `registered !== this` among them, which would then run `policiesFor` against
 * a class it had never seen before on every call.
 *
 * A `WeakMap` on the outside so a model class that goes out of scope takes its
 * bound variants with it, which matters for tests that define models inline.
 */
const boundToConnection = new WeakMap<object, Map<string, typeof Model>>();

export abstract class Model {
  /**
   * Protected, so `new UserModel()` is a type error.
   *
   * Not stylistic. The generated bases merge the row's columns into their
   * instance type via a same-named interface, which is what lets a method on a
   * subclass read `this.email` — and the cost of declaration merging is that
   * TypeScript does not check those properties are ever initialised. A directly
   * constructed instance would therefore type as carrying every column while
   * holding none.
   *
   * Closing the constructor removes that hazard rather than documenting it: the
   * only way to get an instance is `wrap`, which assigns a complete row. Every
   * other operation returns plain objects and never constructs one.
   */
  protected constructor() {}

  /** Assigned by the generated subclass from `app/models/generated/schema.ts`. */
  static $schema: ModelSchema;

  /**
   * Set to `true` by the generator on each base it emits, and by nothing else.
   *
   * `registerModels` has to tell a generated base from an application class
   * written over it, because when both are in one namespace the subclass is the
   * one that must own the name — electing the base *is* #316's leak. It used to
   * answer that by asking whether a class declared `$schema` itself, which is an
   * inference about how the generator happens to be written rather than a
   * statement by the generator, and a subclass that redeclared `static $schema`
   * read as a base because of it. This is the generator saying so.
   *
   * **`declare`, and it has to stay `declare`.** The property must not exist on
   * `Model` at runtime: `isGeneratedBase` reads `"$generated" in candidate` to
   * decide whether the artifacts in front of it carry the mark at all, and falls
   * back to the old inference for artifacts generated before this existed. A
   * `Model.$generated` of `undefined` would answer that question `true` for
   * every class, in every app, including the ones with no mark to read.
   * `registration.test.ts` pins it.
   *
   * **`?: true` and not `?: boolean`**, which is what makes a hand-written
   * `static $generated = false` the type error `isGeneratedBase` reads it as.
   * The cost is that the generator has to emit a non-widening initialiser —
   * `static readonly $generated = true`, since a mutable one widens to
   * `boolean` and every emitted class becomes a TS2417. That happened;
   * `tsconfig.generated.json` is the check that catches it now.
   */
  declare static $generated?: true;

  /**
   * The model's own policies, in the order they should apply.
   *
   * A list rather than the single `$policy` this replaced, because composition
   * is the normal case and the two ways of expressing it against one slot were
   * both bad. Spreading (`{ ...softDeletes(), ...mine }`) silently drops
   * whichever `scope` came first, and an intermediate base class per combination
   * means one throwaway class for every model a shared policy applies to — the
   * generated bases all differ, so a `TenantScoped` used on three models needed
   * three of them.
   *
   * Each level of the prototype chain contributes its own array and they
   * concatenate base first, so a shared model base can still impose a policy
   * that a subclass can only narrow. See `policiesFor`.
   *
   * Entries may be policy objects or classes; a class is instantiated once. The
   * generated `<Model>Policy` type gives an object literal here full contextual
   * typing, which a bare `$policies = [...]` does not get on its own.
   */
  static $policies?: readonly PolicyEntry[];

  /**
   * The connection this class's operations run on, set only by `on` below.
   *
   * `undefined` — which is what every model an application writes has — means
   * *the ambient connection*, not *the default one*. The two differ inside
   * `DB.connection("analytics").transaction(...)`, where an unqualified query
   * has to join the open transaction rather than quietly reach for the hot
   * path's pool.
   */
  static $connection?: string;

  /**
   * The same model, reading and writing on a named connection.
   *
   *     const rows = await Subscription.on("analytics").findMany({ where })
   *
   * **Per query, not per model**, which is the shape the problem actually has:
   * the same `Subscription` is read on the hot path during sign-in and swept by
   * the nightly audit. A `static $connection = "analytics"` on the class would
   * force one of those two to be wrong, so the choice lives at the call site
   * and every query that does not make it stays on the default connection.
   *
   * What it returns is the model class with the connection bound to it, so the
   * whole typed surface — all fifteen operations, `transaction`, `save` — is
   * there unchanged and narrows exactly as it does on the class itself. The
   * connection reaches nested `include` reads and nested writes as well, which
   * an argument on `findMany` could not have done: those recurse through the
   * *target* model's `$exec` by way of the registry, so it is carried in the
   * ambient scope rather than in anyone's parameter list.
   *
   * **A transaction cannot span connections.** Naming one inside a transaction
   * open on another raises `CrossConnectionTransactionError` rather than
   * running the statement outside the transaction, where it would survive the
   * rollback. See that error for why refusing is the only honest answer.
   *
   * An unknown name raises `UnknownConnectionError` at the query, not here:
   * `on` is a pure lookup and does not resolve the container, so a model bound
   * in a module's top-level scope cannot force the database open at import
   * time.
   */
  static on<T extends typeof Model>(this: T, connection: string): T {
    let byName = boundToConnection.get(this);
    if (byName === undefined) boundToConnection.set(this, (byName = new Map()));

    const cached = byName.get(connection);
    if (cached !== undefined) return cached as T;

    // A subclass rather than a Proxy. Both would forward the operations, but a
    // subclass *is* a class: `policiesFor` walks the prototype chain with
    // `Object.hasOwn`, the generated statics are inherited by the language
    // rather than by a trap, and `$exec`'s `this` needs no special handling to
    // stay bound to it.
    const bound = class extends (this as unknown as typeof Model) {
      static $connection = connection;
    };

    // Otherwise the class expression takes its name from the binding above and
    // every error that names the model says "bound". `UnregisteredPolicyClassError`
    // reads `this.name` in particular, and it is exactly the kind of message
    // that has to name the class the caller wrote.
    Object.defineProperty(bound, "name", {
      value: (this as { name: string }).name,
      configurable: true,
    });

    byName.set(connection, bound);
    return bound as unknown as T;
  }

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

  /**
   * Runs `fn` with policies scoped to `user`, for code that acts on somebody's
   * behalf without a request to read them from — a queue job, a scheduled
   * report, a test.
   *
   * The narrow counterpart to `asSystem`, and deliberately the easier of the
   * two to reach for. A worker handling "send the invoice for organisation 7"
   * acts *as* a user; giving it only `asSystem` would suspend policies outright
   * and leave it hand-scoping every query, which is the unscoped-by-accident
   * outcome deny-by-default exists to prevent.
   *
   *     await Model.asUser(owner, () => Invoice.findMany({}))
   */
  static asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
    return runAsUser(user, fn);
  }

  /**
   * Persists the changes made to a *tracked* row: `update` with only the columns
   * whose value differs from what was fetched.
   *
   *     const user = await User.findUnique({ where: { id } }, { track: true })
   *     user.name = "new name"
   *     await User.save(user)     // update "User" set "name" = ?, … where "id" = ?
   *
   * Most of Eloquent's write ergonomics while returns stay plain objects — no
   * proxies, no conditional return types, no signature that changes with a flag.
   * That is invariant 5's whole claim, and this is the thing that tests it.
   *
   * Goes through `$exec("update", …)` rather than around it, so policies,
   * `@updatedAt`, the ambient transaction and the plan cache all apply exactly as
   * they do to a hand-written update. The changed-column *set* is the plan's
   * shape and the values are parameters, so two saves touching the same columns
   * share one plan.
   *
   * Returns `null` when nothing changed, having issued no statement — a save of
   * an untouched row should not stamp `@updatedAt`.
   *
   * Raises when handed an object with no provenance. See `untracked` for why
   * that is a loud failure rather than a fallback to writing everything.
   *
   * **It writes back to the connection the row was read on**, which is the one
   * place a connection cannot be resolved from the ambient scope: a row read on
   * `analytics` is an ordinary object that outlives the scope that produced it,
   * and by the time it is saved — three functions later, from code that never
   * named a connection — the scope is gone. So the connection is part of the
   * row's provenance, exactly as the model and the primary key are, and for the
   * same reason. Left to the ambient default, `save` compiled a correct
   * `update` and sent it to the wrong database, where the same id usually names
   * a real and different row.
   *
   * Naming a *different* connection explicitly — `User.on("default").save(row)`
   * for a row read on `analytics` — is a contradiction rather than an
   * instruction, and raises. Copying a row between connections is a write in
   * its own right: say it with `update`, where the `where` and the `data` are
   * both visible.
   */
  static async save<T extends object>(row: T): Promise<unknown> {
    const schema = this.$modelSchema();
    const record = provenanceOf(row);

    if (!record) throw untracked(row, schema.name);

    if (record.model !== schema.name) {
      throw new UnsupportedQueryError(
        "save",
        schema.name,
        "save",
        `This row came from ${record.model}, not ${schema.name}. Save it ` +
          `through the model it was read from.`,
      );
    }

    if (
      this.$connection !== undefined &&
      this.$connection !== record.connection
    ) {
      throw new UnsupportedQueryError(
        "save",
        schema.name,
        "save",
        `This row was read on the "${record.connection}" connection and this ` +
          `save names "${this.$connection}". A save writes the row back where ` +
          `it came from, so the two cannot both be honoured. Drop the ` +
          `\`on("${this.$connection}")\`, or write it as an explicit ` +
          `${schema.name}.on("${this.$connection}").update({ where, data }) if ` +
          `copying it across connections is what you meant.`,
      );
    }

    // A row selected without its primary key has `key = { id: undefined }`, and
    // `matchUniqueKey` drops undefined members — so the update fails with
    // "update needs a unique field", pointing at a `where` the caller never
    // wrote. Named here instead, where the actual mistake is knowable: this can
    // only mean the select omitted the key.
    const missingKey = schema.primaryKey.filter(
      (name) => record.key[name] === undefined,
    );
    if (missingKey.length > 0) {
      throw new UnsupportedQueryError(
        "save",
        schema.name,
        "save",
        `This row was fetched without ${missingKey.join(", ")}, so there is no ` +
          `way to identify which row to update. A tracked row needs its primary ` +
          `key: add ${missingKey.map((name) => `${name}: true`).join(", ")} to ` +
          `the select, or drop the select to fetch every column.`,
      );
    }

    const changed = changedFields(row, schema);
    if (Object.keys(changed).length === 0) return null;

    // On the row's own connection, entered here rather than left to `$exec`:
    // `$exec` resolves the *ambient* name, and the whole point is that the row
    // outlived the scope that read it. Inside a transaction on another
    // connection this raises `CrossConnectionTransactionError` from `$exec`,
    // which is the correct answer — that update cannot join the transaction, so
    // it must not run at all.
    const updated = await runOnConnection(record.connection, () =>
      this.$exec("update", {
        where: record.key,
        data: changed,
      }),
    );

    // Copy the *returned* row back over the caller's, not just the values sent.
    //
    // `@updatedAt` is stamped by the compiler and is therefore never in
    // `changed`, so without this the in-memory row keeps the timestamp it was
    // fetched with while the database holds a newer one — a caller reading
    // `user.updatedAt` after a successful save silently gets the old instant. The
    // same applies to anything else the database rewrote.
    //
    // Resnapshotting from the same source is what keeps the row and its snapshot
    // in agreement, so a second `save` is still a no-op.
    if (updated && typeof updated === "object" && !Array.isArray(updated)) {
      const fresh = updated as Record<string, unknown>;
      const target = row as Record<string, unknown>;
      const persisted: Record<string, unknown> = {};

      for (const name of Object.keys(fresh)) {
        if (!(name in schema.fields)) continue;
        target[name] = fresh[name];
        persisted[name] = fresh[name];
      }

      resnapshot(row, persisted);
    } else {
      resnapshot(row, changed);
    }

    return updated;
  }

  /**
   * Turns a **complete** row into an instance of this class, for code that wants
   * behaviour rather than data.
   *
   *     const user = User.wrap(await User.findUniqueOrThrow({ where: { id } }))
   *     user.displayName          // a method on your subclass
   *     await user.save()
   *
   * Explicit, never implicit, and that is the whole design. The moment queries
   * hydrate by default, the `select` conflict comes back: a method that reads
   * `this.email` on a row fetched as `select: { id: true }` is a runtime crash
   * the type system cannot see. Keeping `wrap` a call the author makes means
   * narrowing and behaviour never meet.
   *
   * **Completeness is required, and the requirement is not arbitrary.** The
   * generated signature takes the full scalar payload, so a `Pick` of it is a
   * compile error rather than a runtime surprise (there is a type test for
   * exactly that). It is the same constraint that makes `save()` work on the
   * result: a complete row is one this can snapshot in full, so an instance is
   * tracked without the caller asking. The type constraint and the save
   * capability are one constraint, not two.
   *
   * Note the instance is a *copy*: mutating it does not touch the row that was
   * passed in, and `save()` diffs against what `wrap` received.
   */
  static wrap(row: object): any {
    const schema = this.$modelSchema();
    const instance = new (this as unknown as new () => any)();

    Object.assign(instance, row);
    // Tracked on the instance, not the argument — `save()` on the instance has
    // to diff against the values it was constructed from.
    //
    // The connection is the argument's, when the argument has one. `wrap` runs
    // *after* the query's scope has closed, so the ambient name here is
    // whatever the caller happens to be in — usually the default — and a row
    // read on `analytics` would be wrapped into an instance whose `save()`
    // wrote to the hot path. Taken in order: an explicit `on`, then where the
    // row actually came from, then the ambient connection for a row that was
    // never tracked at all.
    track(
      instance,
      schema,
      this.$connection ??
        provenanceOf(row)?.connection ??
        currentConnectionName(),
    );

    return instance;
  }

  /**
   * Persists this instance's changes. The instance counterpart of the static, and
   * a one-line delegation to it so there is one implementation.
   */
  save(): Promise<unknown> {
    return (this.constructor as typeof Model).save(this);
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
   *
   * **KNOWN DIALECT ASYMMETRY — catching an error inside a transaction.**
   * The sentence above holds for a *nested* `Model.transaction`. It does not
   * hold for a bare statement: on Postgres any failed statement aborts the
   * whole transaction block, so catching it and carrying on loses everything.
   * SQLite does not care. Verified against Postgres 16 and SQLite:
   *
   *     await Model.transaction(async () => {
   *       try { await User.create({ data: { email } }) }
   *       catch (e) { if (!(e instanceof UniqueConstraintError)) throw e }
   *       await Audit.create({ ... })   // fine on SQLite; on Postgres this
   *     })                              // throws 'current transaction is
   *                                     // aborted', and the whole transaction
   *                                     // is lost
   *
   * That is a bug that passes in development on SQLite and takes out the
   * transaction in production on Postgres, with an error naming neither the
   * statement that failed nor the one that caused it.
   *
   * The fix is already here: wrap the fallible statement in a nested
   * `Model.transaction`, which makes it a savepoint, and rolling back to that
   * savepoint clears the aborted state. Works on both dialects.
   *
   *     await Model.transaction(async () => {
   *       try {
   *         await Model.transaction(() => User.create({ data: { email } }))
   *       } catch (e) { if (!(e instanceof UniqueConstraintError)) throw e }
   *       await Audit.create({ ... })   // fine on both
   *     })
   *
   * **One statement at a time.** Every query in scope runs on one reserved
   * connection, so `Promise.all` over several ORM calls inside the callback is
   * not safe here — the ordinary, encouraged thing everywhere else in a Bun
   * codebase. Await them in sequence. (`$exec` already runs its own nested
   * writes and relation reads sequentially for this reason.)
   *
   * **The connection is held for as long as the callback runs**, including
   * while it awaits things that are not queries. In development a transaction
   * still open after 2s warns — `database.slowTransactionThreshold` sets that
   * bound, or `false` switches it off. In production it just holds the
   * connection. Keep network and filesystem I/O outside.
   */
  // `async`, so that naming a connection this transaction cannot reach —
  // `Subscription.on("analytics").transaction(...)` inside a transaction on the
  // hot path — *rejects* rather than throwing synchronously. The same reasoning
  // `DB.query` records: an API that does one sometimes and the other otherwise
  // is a footgun, and a `.catch()` would miss exactly this error.
  static async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // `Subscription.on("analytics").transaction(...)` opens on that connection,
    // and a bare `Model.transaction` opens on whatever is ambient — which is
    // the default connection unless something outside has already named one.
    // `withTransaction` refuses the mismatch; there is no second check here.
    const name = this.$connection ?? currentConnectionName();

    return transact(app(DatabaseManager).connection(name), () =>
      runOnConnection(name, () => fn()),
    );
  }

  /**
   * The choke point's outer half: which connection this operation runs on.
   *
   * Split from the body below so that the name is resolved and entered
   * **once**, around everything — the policy pass, the plan lookup, the nested
   * writes and every relation read that recurses back through here. The
   * alternative, resolving it inside, would have left each nested read to
   * rediscover it, and the one that did not would have run against the default
   * connection with no error to show for it.
   *
   * Recursive calls cost a comparison: the ambient name already matches, so
   * `runOnConnection` calls straight through without entering a second scope.
   *
   * `async` for the reason `transaction` is: an operation refused for naming a
   * connection the open transaction cannot reach has to reject like every other
   * failure `$exec` produces, rather than being the one that throws before the
   * promise exists.
   *
   * The cross-connection refusal is `runOnConnection`'s, not repeated here:
   * *entering* the connection is the only moment at which the scope still holds
   * both the open transaction and the name it belongs to, so that is where the
   * comparison has to live.
   */
  static async $exec(
    op: Operation,
    args: any = {},
    options?: ExecOptions,
  ): Promise<unknown> {
    return runOnConnection(this.$connection ?? currentConnectionName(), () =>
      this.$execute(op, args, options),
    );
  }

  private static async $execute(
    op: Operation,
    args: any = {},
    options?: ExecOptions,
  ): Promise<unknown> {
    const schema = this.$modelSchema();

    // Resolved per call, never captured at module scope: that is what keeps the
    // connection swappable in tests.
    //
    // Through `connection()` rather than off the manager directly, so that a
    // query on a named connection reads *that* pool's client and dialect. The
    // default connection is the manager itself, which is what keeps every
    // existing wrapper of it — the harnesses that Proxy `sql` to count
    // statements — looking at the object this executes through.
    const db = app(DatabaseManager).connection(currentConnectionName());
    const dialect = dialectFor(db.dialect);

    // The ambient-transaction hook, and the entire integration. It is one line
    // — and it covers every operation, every nested write and every relation
    // read — only because invariant 1 held: `$exec` is the single door. An
    // operation that acquired a private path to the database would show up
    // here as a statement silently running outside the transaction, committed
    // while its neighbours roll back.
    // `let`, because a multi-statement write opens a transaction of its own
    // further down and every statement after that point — including the
    // `executor.query` closure below, which captures this binding rather than
    // its value — has to run on the new handle rather than back on the pool.
    let conn = currentTransaction() ?? db.sql;

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
    const system = isSystemScope();
    const policies = system ? [] : policiesFor(this);
    let policy: PolicyContext | undefined;
    let effective = args;

    // POLICY-DIVERGENCE GUARD.
    //
    // A nested relation read resolves its target through the registry, so it
    // runs whatever is registered under this model's name — not necessarily the
    // class the caller queried. When those two disagree about *policies*, the
    // same policy applies to some queries and not others, silently. Both
    // directions are reachable and both are the same bug:
    //
    //   policied class not registered  -> root scoped, nested reads unscoped
    //   policied class registered, but -> nested reads scoped, a direct query
    //   the caller queries the base       through the base unscoped
    //
    // The second is the one this check sat inside `policies.length > 0` and
    // therefore missed: querying `AccountModel` when `Account` owns the name
    // finds no policies on `AccountModel`, so the old placement never looked.
    // `AccountModel` and `Account` come out of the same barrel with near
    // identical names, so it needs no include and no mistake worth calling one.
    //
    // Keyed on the *divergence*, not on either class having policies. The
    // comparison is of the resolved policy chain rather than class identity: a
    // plain subclass of a registered, policied class inherits the same policy
    // objects in the same order, so nothing diverges and there is nothing to
    // refuse — checking identity rejected `class AdminUser extends User {}`, a
    // typed view, for policies it had not written.
    //
    // `!system` is load-bearing. Under `asSystem` policies are suspended by
    // design, so a seed script querying the generated base directly is correct
    // and must not raise.
    //
    // Cost on the common path: one `Map.get` and one reference compare, for a
    // model where nothing is registered under a different class.
    //
    // `inheritsPoliciesFrom` keeps that true for `Model.on(name)`, whose bound
    // subclass is never the registered class and so failed the reference
    // compare on *every* query — leaving each one to resolve the registered
    // chain and walk it twice to reach the same conclusion. A direct subclass
    // that declares no policies of its own has, by construction, the chain its
    // parent has: there is nothing to compare.
    if (!system) {
      const registered = registry.has(schema.name)
        ? registry.get<unknown>(schema.name)
        : undefined;

      if (
        registered !== undefined &&
        registered !== this &&
        !inheritsPoliciesFrom(this, registered)
      ) {
        const theirs = policiesFor(registered);
        const diverges =
          policies.length !== theirs.length ||
          policies.some((entry, index) => entry !== theirs[index]);

        if (diverges) {
          throw new UnregisteredPolicyClassError(
            schema.name,
            (registered as { name?: string }).name ?? String(registered),
            this.name,
            policies.length > 0 ? "queried" : "registered",
          );
        }
      }
    }

    // NESTED policies, applied to the argument tree before the plan key.
    //
    // A nested read under the batched strategy would acquire its own policies by
    // recursing through the child's `$exec` — but a lateral join has no such call,
    // so the child's policies would never be consulted and the subquery would be
    // unscoped. Applying them here, on the args, keeps the compiler pure and makes
    // the scope part of whatever SQL a strategy chooses to emit. See
    // `applyNestedPolicies` and `plans/orm/09-lateral-strategy.md`.
    //
    // `preScoped` is how the double application is avoided: the relation executor
    // marks its recursive calls, so a child whose args arrived already scoped does
    // not scope them again. Without it a batched include would `AND` the same
    // predicate twice — the same rows, but different SQL and a different plan key.
    const preScoped = isPreScoped(options);

    if (!system && !preScoped) {
      effective = applyNestedPolicies(
        schema,
        effective,
        currentUser(),
        system,
        (model) => {
          if (!registry.has(model)) return undefined;
          const target = registry.get<typeof Model>(model);
          const targetSchema = target.$schema;
          if (!targetSchema) return undefined;
          return { policies: policiesFor(target), schema: targetSchema };
        },
      );
    }

    // `upsert` whose `create` does not set the conflict key, which used to
    // raise — and which is decided **before** policies are applied, on purpose.
    //
    // The last of iteration 4's three "not before iteration 5" items. That note:
    // "Prisma means find-then-write there; expressing that takes a read and a
    // write inside one transaction, which is iteration 5's."
    //
    // Checked against a generated Prisma 6 client rather than reasoned about,
    // because the semantics are surprising: `upsert({ where: { publicId: "X" },
    // create: { email } })` inserts a row whose `publicId` is **generated**, not
    // "X". The `where` selects; it does not contribute to the insert.
    //
    // **`on conflict` is kept wherever it works.** It is one atomic statement,
    // and read-then-write is not — two callers can both miss and both insert.
    // Prisma's upsert has that race and this inherits it, but only on calls that
    // previously raised: nothing that worked becomes racy.
    //
    // **Before policies, and that is what lets a scoped model upsert at all.**
    // `assertScopable` refuses to put a scope on an `upsert`, because its where
    // becomes an `on conflict` target and a target cannot carry a predicate.
    // That reason is exactly true of the `on conflict` path and false of this
    // one, which is three ordinary statements. Deciding here means the three run
    // as `findFirst`, `create` and `update`, each scoped normally by its own
    // `$exec` — so this branch is *not* marked pre-scoped, and a policied model
    // gets a working upsert instead of a refusal whose justification expired.
    //
    // A policy that branches on `context.operation` therefore sees the three it
    // actually runs rather than the one the caller named. That is the honest
    // reading: the operation really is three statements here.
    if (op === "upsert" && !preScoped && findThenWrite(schema, args, op)) {
      const { where, create, update, ...projection } = args;

      return transact(db, async () => {
        const found = await this.$exec("findFirst", { where }, options);

        return found === null
          ? await this.$exec("create", { data: create, ...projection }, options)
          : await this.$exec(
              "update",
              { where, data: update, ...projection },
              options,
            );
      });
    }

    if (policies.length > 0) {
      // Deny-by-default lives on the context's `user` accessor, not here: a
      // policy that never consults the user — a soft-delete scope, say — has
      // nothing to deny and must keep working with no request in sight. See
      // `policyContext`.
      //
      // `redactedAs` is the one thing that can make `context.operation` differ
      // from `op`, and it exists to *remove* a difference the caller can see: a
      // `delete` that has to read before it writes runs its pre-read as a
      // `findFirst` and hands that row back, so without this a `redact` keyed on
      // `"delete"` stopped firing the moment the call also carried an `include`
      // (#366). The row is the delete's return value; it is redacted as one.
      //
      // **Only on a pre-scoped call, which is what keeps it a redaction
      // concern.** `applyPolicies` below is skipped when `preScoped`, so on the
      // one call that sets this marker the context reaches nothing but
      // `applyRedaction`. Reading the marker unconditionally would leave a
      // shape — a future non-pre-scoped caller — where a `before` or a `scope`
      // could be handed an operation the statement is not, and `SCOPABLE` is
      // keyed on exactly that. The guard makes that shape unrepresentable
      // rather than merely absent.
      policy = policyContext(
        schema.name,
        (preScoped ? redactedAs(options) : undefined) ?? op,
        currentUser(),
        system,
      );

      // **The context is built even when pre-scoped; only the rewrite is
      // skipped.** `preScoped` means "the scope is already in these args" — not
      // "this model has no policies". Guarding the whole block on it left
      // `policy` undefined for every nested relation read, and `policy` is what
      // `applyRedaction` below is keyed on. So a `redact` protected a root query
      // and was skipped inside every `include`: scoped one way, unscoped the
      // other, which is the failure iteration 6 exists to prevent.
      //
      // Only `applyPolicies` is idempotency-sensitive. Re-running it would `AND`
      // the same predicate twice; re-running `redact` on an already-redacted row
      // is a no-op.
      if (!preScoped) {
        effective = applyPolicies(
          policies,
          policy,
          args,
          ormAuthoredFields(options),
        );
      }
    }

    // Which strategy plans the include tree. Named per call or chosen by
    // `defaultStrategy`, and either way it reaches the plan key — two strategies
    // emit different SQL for the same arguments, so sharing a plan between them
    // would run one request's statement for the other's.
    const strategy = resolveStrategy(options?.strategy, dialect, {
      model: schema.name,
      operation: op,
    });

    // `createMany` past the driver's parameter ceiling, which used to raise.
    //
    // Iteration 4 refused to chunk and said why: "it would make this several
    // statements, which cannot be made atomic until transactions land." They
    // landed in iteration 5. So the split happens here, inside one transaction,
    // and the caller gets the same `{ count }` a single statement would have
    // returned.
    //
    // **Only on the call that would otherwise have failed.** The ceiling is
    // checked in `render`, so the ordinary path pays nothing for this — it is a
    // `catch`, not a size check on every write. A `createMany` small enough to
    // compile never enters it.
    if (op === "createMany" && Array.isArray(effective?.data)) {
      const chunks = chunkedCreateMany(
        schema,
        effective,
        dialect,
        strategy,
        op,
      );

      if (chunks !== null) {
        return transact(db, async () => {
          let count = 0;
          for (const data of chunks) {
            const written = (await this.$exec(
              "createMany",
              { ...effective, data },
              markPreScoped({ strategy: options?.strategy }) as never,
            )) as { count: number };
            count += written.count;
          }
          return { count };
        });
      }
    }

    const plan = getOrCompile(schema, op, effective, dialect, strategy);

    const executor: RelationExecutor = {
      // `markPreScoped`: this model's policies were already applied to
      // `relationArgs` by the parent's nested walk, so re-applying them here
      // would `AND` the same predicate twice — same rows, different SQL,
      // different plan key. The marker is a module-private Symbol and is not
      // exported, so it cannot become a way for an application to skip policies.
      // The strategy propagates too. Without it a nested `$exec` fell back to
      // `defaultStrategy`, so a query explicitly asking for `batched` got the
      // *default* for every level below the root — on Postgres that meant the
      // grandchild folded anyway and the statement count was one lower than the
      // caller asked for. Found by the query-count test, which is the only thing
      // that could have found it: the results were identical either way.
      exec: (model, operation, relationArgs, preScoped, ormAuthored) => {
        const base = preScoped
          ? markPreScoped({ strategy: options?.strategy })
          : { strategy: options?.strategy };
        return registry
          .get<typeof Model>(model)
          .$exec(
            operation as Operation,
            relationArgs,
            (ormAuthored && ormAuthored.length > 0
              ? markOrmAuthored(base, ormAuthored)
              : base) as never,
          );
      },
      // The one query with no model behind it — the implicit m-n join table —
      // resolves its connection here rather than reaching for the pool, so it
      // joins the transaction like everything else.
      query: (text, values) => conn.unsafe(text, values),
    };

    // One context per call, holding the instant every `now()` and `@updatedAt`
    // on this operation shares, plus whatever the `before` steps resolve.
    const context = createBindContext();

    // `delete` with an `include` on a **cascading** relation, which returned the
    // children empty until now.
    //
    // The relation reads run after the delete statement, so where the schema
    // declares `onDelete: Cascade` the database has already removed the children
    // by the time they are read. Prisma runs the whole thing in a transaction and
    // returns them as they were. `compileDelete` recorded this as "not fixable at
    // this layer — the fix is to read the relations before the delete inside one
    // transaction, which is iteration 5's to provide".
    //
    // Iteration 5 provided it. Read first, delete second, return what was read:
    //
    // - **A transaction, so the pair is atomic.** Without one, a delete that
    //   fails after the read would leave the caller holding a row that still
    //   exists. Nested inside a caller's transaction it is a savepoint, which is
    //   what `withTransaction` already does.
    // - **`markPreScoped` on both**, because `effective` has been through this
    //   model's policies once already; re-applying them would `AND` the same
    //   predicate twice — same rows, different plan key.
    // - **The read is scoped as the delete was**, including its nested policies.
    //   `effective` was rewritten by `applyPolicies` and `applyNestedPolicies`
    //   under operation `"delete"`, and `markPreScoped` stops the pre-read
    //   redoing either — so the `where` the `findFirst` runs is the delete's,
    //   predicate for predicate.
    // - **`markRedactedAs`, so the row is redacted as the delete it belongs
    //   to.** This bullet used to claim `context.operation` was already
    //   `"delete"` here. It was not, and the row it was most wrong about was the
    //   root one — the one returned. The pre-read is a `findFirst`, so
    //   `policyContext` was built with `"findFirst"` and a `redact` keyed on
    //   `"delete"` silently stopped firing as soon as the same call carried an
    //   `include` (#366). The `delete` statement below *does* run under
    //   `"delete"`, and its row is thrown away, so nothing observable came of
    //   that half.
    //
    //   The marker covers the returned row and nothing else. Nested reads keep
    //   seeing `findMany` — `NESTED_READ` in `policy.ts` is a constant on
    //   purpose, because a read of another model is a read whatever statement
    //   encloses it, and that is also what a batched relation read has always
    //   reported here.
    //
    // Only when there is something to read. A plain `delete` still compiles to
    // one statement and opens no transaction.
    //
    // `plan.counts` is here for the same hazard in its quietest form, and the
    // two dialects disagree about it. A `_count` compiles to a correlated
    // subquery inside the `RETURNING`, and where the schema cascades:
    //
    //   postgres  delete … returning (select count(*) from ch …)  ->  3
    //   sqlite    delete … returning (select count(*) from ch …)  ->  0
    //
    // Measured through Bun against a real `on delete cascade` on both. Postgres
    // evaluates the subquery against the pre-statement snapshot, which is what
    // Prisma returns; SQLite evaluates it after the cascade has run, so the
    // count is 0 — a *number*, so nothing looks missing and no error is raised.
    //
    // Reading first answers it the same way it already answers the `include`
    // case, and on both dialects rather than one. A count is not a relation
    // plan, so `relations` stays empty for an `include: { _count: … }` on its
    // own — hence the separate flag rather than a wider check.
    if (op === "delete" && (plan.relations !== undefined || plan.counts)) {
      // **Everything but the `where`, rather than the operands named one by
      // one.** The row this reads is the row the caller gets back — `return
      // before`, below — so an operand left out here is silently un-narrowed,
      // and nothing downstream will notice. That is #364: this rebuilt the
      // projection as `select` *or* `include`, `omit` was not among the names,
      // and a `delete` that asked to drop a column got it back as soon as the
      // same call also carried an `include`. A `delete` with no relation to read
      // never reaches this branch and projects through `resolveSelection`, which
      // had honoured `omit` all along — one operation, two paths, two answers.
      //
      // **Do not turn this back into named arms.** The rest is what makes the
      // next projection operand — Prisma's `relationLoadStrategy`, a `distinct`
      // on a write, whatever it turns out to be — arrive here for free instead
      // of arriving as the same bug with a different column name. The `upsert`
      // find-then-write branch a few hundred lines up spreads for the same
      // reason and was never affected by #364.
      //
      // Bounded, not hopeful. `assertArgs` (`compile/write.ts`) rejects any
      // operand outside `WRITE_ARGS.delete` — `where`, `select`, `include`,
      // `omit` — and the plan above is already compiled, so the rest holds
      // projection operands and nothing else. That set is a strict subset of
      // `findFirst`'s, so every one of them is a legal read operand. `omit` and
      // `select` cannot both be in it: `resolveSelection` refuses that pair, and
      // a warm plan cannot smuggle it past, since both are in `LITERAL_KEYS`
      // (`plan.ts`) and so key separately. An `undefined` operand is dropped from
      // the plan key too, so carrying one costs no second cache entry.
      const { where, ...projection } = effective;

      // The pool, not `conn`: when a transaction is already open `withTransaction`
      // savepoints against the ambient handle and ignores this argument, and
      // passing a transaction handle here would read as though we begin on it.
      return transact(db, async () => {
        const before = await this.$exec(
          "findFirst",
          { where, ...projection },
          // `op` rather than the literal `"delete"`: the branch is guarded on
          // it, so they are the same string, and taking it from the variable
          // keeps the two from drifting if the guard ever admits a second
          // operation that has to read before it writes.
          markRedactedAs(
            markPreScoped({ strategy: options?.strategy }),
            op,
          ) as never,
        );

        // `findFirst` shapes a miss to `null`; the caller asked for a delete, so
        // the error has to name that rather than the read this used underneath.
        if (before === null) throw new RecordNotFoundError(schema.name, op);

        await this.$exec(
          "delete",
          { where },
          markPreScoped({ strategy: options?.strategy }) as never,
        );

        return before;
      });
    }

    // A write with a nested `create` / `connect` runs more than one statement,
    // and those statements are one unit: the parent row and the children it was
    // asked for either all land or none do.
    //
    // This used to be left to the caller — "atomic exactly when the caller
    // wrapped the call in `Model.transaction`, *not* implicitly" — on the
    // reasoning that `$exec` cannot know whether it is one step of a larger unit
    // and that opening one per call would put a `BEGIN` around every query in
    // the framework. The second half of that is right and is why the condition
    // below is what it is; the first half does not survive contact with
    // policies. A nested write step runs the *child's* `$exec`, so the child's
    // policies are consulted mid-sequence, after the parent row is already
    // written. A child that denies therefore left a half-written parent behind,
    // and "your policy stopped the write" and "your policy stopped half the
    // write" are not the same promise.
    //
    // So: implicit, but only for the calls that are actually multi-statement.
    // A plain `create` still compiles to one statement and opens nothing, which
    // is what keeps the `BEGIN`-around-everything objection answered — and
    // inside a caller's own transaction `withTransaction` takes a savepoint
    // rather than nesting a second one.
    const finish = async (): Promise<unknown> => {
      // Re-resolved rather than reused: if the branch below opened a
      // transaction, every statement from here on belongs to it. Outside one
      // this is the same handle it already was.
      conn = currentTransaction() ?? conn;

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

      // ...and a `_count` on the same call has to be recomputed once they have,
      // for the same reason `include` is attached after them rather than before.
      //
      // A count is a correlated subquery inside the write's own `RETURNING`, so
      // it is evaluated at the instant the parent row is inserted — before any
      // `after` step has written a child. That produced a single response
      // contradicting itself:
      //
      //   User.create({ data: { …, accounts: { create: [a, b] } },
      //                 include: { accounts: true, _count: { … } } })
      //
      //   accounts.length  2      attached after the steps
      //   _count           0      projected before them
      //
      // Both keys describe the same relation on the same row. The row itself was
      // never wrong — reading it back gives 2 — so this is the projection being
      // frozen, which is the mirror of the `delete` case above: there the count
      // is taken too late, here too early.
      //
      // **Only when there is something to be wrong about.** A write with no
      // `after` steps keeps the projected value and costs nothing extra; one
      // with both pays a single read. `plan.counts` is what makes that condition
      // cheap enough to ask on every write.
      //
      // **Between `runSteps` and the `hidden` deletion, and that is
      // load-bearing.** `select: { email, _count: … }` never asks for the
      // primary key, so the key the recount reads the row by is on it only
      // because the plan added it for the nested write and has not stripped it
      // yet. Move this after the strip and the recount loses its identifier;
      // move it before `runSteps` and there is nothing new to count.
      if (plan.counts && plan.after !== undefined) {
        await recountAfterSteps(
          schema,
          this as unknown as typeof Model,
          effective,
          rowsOf(result),
          options,
        );
      }

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

      // A **folded** relation's rows never entered the child's `$exec`, so nothing
      // has run the child's `redact` over them. The comment below — "a related row
      // was shaped by its own model's `$exec`" — is true of the batched strategy
      // and false of the lateral one, which is precisely the kind of assumption
      // iteration 9 had to revisit for `scope`.
      //
      // `scope` survived the fold because policies rewrite the *argument tree*
      // before planning, and a scoped `where` lands inside the subquery. `redact`
      // cannot: it is a row transform in the shaping stage, with no argument to
      // rewrite. So the parent runs it on the child's behalf, which is the only
      // place that can.
      if (plan.relations !== undefined && !system) {
        for (const relation of plan.relations) {
          if (relation.root === undefined) continue;
          redactFolded(
            {
              as: relation.as,
              model: relation.model,
              folded: relation.root.folded,
            },
            result,
            op,
            system,
          );
        }
      }

      // Redaction last, on the shaped result. After relations, not before: a
      // related row was shaped by its own model's `$exec` and has already been
      // through its own policy's `redact` — this one only owns its own rows.
      if (policy) applyRedaction(policies, policy, result);

      // Provenance, after redaction so a redacted field is not snapshotted as its
      // original value and then written back by `save`.
      //
      // Here rather than inside `$shape`, which is where the plan sketched it, for
      // one reason: `$shape` is the seam an `ActiveRecordModel` overrides to
      // return instances, and tracking there would make every such override
      // responsible for reimplementing it. Doing it at the choke point means an
      // override gets provenance for free — which is the same argument that put
      // everything else in `$exec`.
      if (options?.track === true) {
        for (const row of rowsOf(result)) track(row, schema);
      }

      return result;
    };

    const atomic =
      (plan.before !== undefined && plan.before.length > 0) ||
      (plan.after !== undefined && plan.after.length > 0);

    return atomic ? transact(db, finish) : finish();
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

/**
 * Whether `queried` can only have the policies `registered` has.
 *
 * True for a direct subclass that declares none of its own — which is what
 * `Model.on(name)` builds, and also what `class AdminUser extends User {}` is.
 * `policiesFor` walks the prototype chain and takes each level's own
 * `$policies`; a level that declares none contributes nothing, so the walk from
 * here and the walk from the parent visit the same levels in the same order and
 * cannot disagree.
 *
 * Structural rather than a flag on the classes `on` mints, so the typed-view
 * subclass the divergence guard already argues should be allowed gets the same
 * short-circuit rather than paying for a second resolution of the chain.
 *
 * `$policy` — the removed name — is deliberately not checked: `policiesFor` has
 * already walked this class by the time this is called, and it raises on that
 * name at any level, so a class carrying it never reaches here.
 */
function inheritsPoliciesFrom(queried: unknown, registered: unknown): boolean {
  return (
    Object.getPrototypeOf(queried) === registered &&
    !Object.hasOwn(queried as object, "$policies")
  );
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
 * The skew warning, gated on this process's **zone** — resolved once, here.
 *
 * Reading the clock per call cost a `Date` allocation on the one path every
 * query takes — ~60ns, against under a nanosecond for the closed-over boolean
 * that replaces it — and the latch inside only ever closes on a *firing*, so
 * the deployment that is configured correctly and never warns paid it forever.
 *
 * `clockCouldSkew()` asks the question whose answer cannot change under a
 * running process: not "is the offset zero today", which is also true of
 * `Europe/London` every winter, but "is this zone ever off UTC at all". A UTC
 * process never enters the check; anything else stops entering once it has said
 * its piece, and reads the clock only until then — see `protocol-skew.ts`,
 * which owns both halves so that both can be tested from a UTC machine.
 */
const warnProtocolSkewOnce = createProtocolSkewWarner(clockCouldSkew(), () =>
  new Date().getTimezoneOffset(),
);

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
  // Said once per process, and only for the configuration that silently returns
  // the wrong instant — see `protocol-skew.ts`. Printing is left here because
  // this is the layer allowed to talk to the operator; deciding is not, because
  // nothing that needs a database can be tested in the one configuration CI
  // runs.
  const warning = warnProtocolSkewOnce(dialect.name, schema, text, values);
  if (warning) console.warn(warning);

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

/**
 * Re-reads the `_count` for rows whose children were written by an `after` step.
 *
 * One read per row rather than one for all of them, and that is not a
 * concession: every write that can carry both a `_count` and an `after` step is
 * a single-row operation — `create`, `update`, `upsert`. `createMany` takes no
 * `include` at all. So the loop runs once, and writing it as a loop keeps a
 * compound primary key expressible without an `in` list over tuples.
 *
 * **Pre-scoped, deliberately.** `effective` has already been through this
 * model's policies and `applyNestedPolicies` has already scoped the `_count`
 * node, so re-applying them would `AND` the same predicate twice — the same
 * rows, a different plan key. This is the same reasoning `delete`'s read-first
 * path uses, a few hundred lines up.
 */
async function recountAfterSteps(
  schema: ModelSchema,
  model: typeof Model,
  effective: any,
  rows: Record<string, unknown>[],
  options: unknown,
): Promise<void> {
  const node = effective?.include?._count ?? effective?.select?._count;
  if (node === undefined || rows.length === 0) return;

  for (const row of rows) {
    // **Every component present, or nothing.** What the plan guarantees is on
    // the row is the *link* field — `planForeignSide` pushes `link.parentField`
    // into `keyFields`, which is the column the relation `references`, and that
    // is the primary key only by convention. Declare a relation
    // `references: [publicId]`, ask for `select: { email, _count }`, and `id` is
    // simply not there.
    //
    // The failure that would produce is the bad kind. `compileWhere` drops
    // `undefined` keys, so a `where` built entirely from missing components
    // compiles to **no predicate at all**:
    //
    //   findFirst({ where: { id: undefined } })  ->  select … from "User" limit ?
    //
    // — an arbitrary row, whose count is a plausible number rather than an
    // error. So an incomplete key means the projected value stands, which is
    // the same answer this already gives for a missing row: stale, not
    // invented. Nothing here can be salvaged by guessing.
    const where: Record<string, unknown> = {};
    let identified = schema.primaryKey.length > 0;
    for (const field of schema.primaryKey) {
      const value = row[field];
      if (value === undefined) {
        identified = false;
        break;
      }
      where[field] = value;
    }
    if (!identified) continue;

    const fresh = (await (model as any).$exec(
      "findFirst",
      { where, select: { _count: node } },
      markPreScoped({ strategy: (options as any)?.strategy }),
    )) as Record<string, unknown> | null;

    // `null` only if the row vanished between the write and this read, which
    // inside the write's own transaction it cannot. Leaving the projected value
    // alone is still the right fallback: it is stale, not invented.
    if (fresh && fresh._count !== undefined) row._count = fresh._count;
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [];
  return [result as Record<string, unknown>];
}

/**
 * Splits a `createMany` that would exceed the driver's parameter ceiling, or
 * returns `null` when it fits.
 *
 * The ceiling is enforced in `render`, so the only way to learn that a call is
 * too large is to try compiling it. That is deliberate rather than lazy: a size
 * check ahead of every write would cost every write, and the plan cache means
 * the compile is paid once per shape anyway.
 *
 * The chunk size comes from **binding one row**, not from dividing the reported
 * total. Division looks equivalent and is not: `required` includes whatever the
 * statement binds besides the rows, so on a shape with any fixed overhead it
 * understates the per-row cost and produces a chunk that is still too large.
 * Binding a single row asks the compiler the question directly.
 */
function chunkedCreateMany(
  schema: ModelSchema,
  args: any,
  dialect: SqlDialect,
  strategy: RelationStrategy,
  op: Operation,
): unknown[][] | null {
  const rows = args.data as unknown[];
  if (rows.length < 2) return null;

  try {
    getOrCompile(schema, op, args, dialect, strategy);
    return null;
  } catch (error) {
    if (!(error instanceof ParameterLimitError)) throw error;

    const single = { ...args, data: [rows[0]] };
    const perRow = getOrCompile(schema, op, single, dialect, strategy).bind(
      single,
      createBindContext(),
    ).length;

    // One row on its own over the ceiling is not a chunking problem — no split
    // can help, and the original error says the useful thing.
    if (perRow === 0 || perRow > error.limit) throw error;

    const size = Math.floor(error.limit / perRow);
    const chunks: unknown[][] = [];
    for (let at = 0; at < rows.length; at += size) {
      chunks.push(rows.slice(at, at + size));
    }
    return chunks;
  }
}

/**
 * Whether an `upsert` has to become a read and a write.
 *
 * True exactly when `create` leaves part of the conflict key unset, which is the
 * case `on conflict` cannot express — the insert could never collide on the
 * target, so the update branch would be unreachable.
 *
 * A `where` that names no unique key, or names several, is not this function's
 * to report: it returns false and lets the ordinary path raise the error it
 * already has for that, with the message it already has.
 */
function findThenWrite(schema: ModelSchema, args: any, op: Operation): boolean {
  try {
    const key = matchUniqueKey(schema, args?.where, {
      model: schema.name,
      operation: op,
      argument: "where",
    });
    return upsertAbsentConflictKey(schema, args, key).length > 0;
  } catch {
    return false;
  }
}

/**
 * Runs a folded relation's own `redact` over the rows the strategy inlined, and
 * then its descendants' over theirs.
 *
 * Only for a plan carrying `root` — a batched child came back through its own
 * `$exec` and has already redacted itself, and doing it twice is harmless but
 * pointless. Only outside `asSystem`, like every other policy.
 *
 * **Recursive, because the fold is.** A lateral node folds its whole subtree into
 * one statement, so a grandchild's rows never enter its model's `$exec` either —
 * and stopping at depth 1 would leave exactly the rows nobody thinks to check
 * unredacted. `RootContribution.folded` is the shape of what was folded, which is
 * the only thing that makes the walk possible.
 *
 * The child's policies are resolved through the registry by name, so this obeys
 * the same rule every nested read does: whatever is registered under that name
 * is the class whose policies apply.
 */
function redactFolded(
  relation: { as: string; model: string; folded?: readonly FoldedRelation[] },
  result: unknown,
  op: Operation,
  system: boolean,
): void {
  const target = registry.has(relation.model)
    ? registry.get<unknown>(relation.model)
    : undefined;
  const policies = target ? policiesFor(target) : [];
  const nested = relation.folded ?? [];

  if (policies.length === 0 && nested.length === 0) return;

  const context =
    policies.length > 0
      ? policyContext(
          (target as { $schema?: { name?: string } }).$schema?.name ??
            relation.model,
          op,
          currentUser(),
          system,
        )
      : undefined;

  // Collected whether or not *this* level redacts anything: an unpolicied model
  // in the middle of the tree must not hide a policied one below it.
  const children: Record<string, unknown>[] = [];

  for (const parent of rowsOf(result)) {
    const rows = parent?.[relation.as];
    if (rows === undefined || rows === null) continue;
    if (context) applyRedaction(policies, context, rows);
    if (nested.length > 0) children.push(...rowsOf(rows));
  }

  for (const child of nested) redactFolded(child, children, op, system);
}
