import type { SQL } from "bun";
import { DatabaseManager } from "../database/DatabaseManager";
import { app } from "../foundation/app";
import { type BindContext, createBindContext } from "./compile/fragment";
import {
  currentTransaction,
  isSystemScope,
  runAsSystem,
  runAsUser,
  withTransaction,
} from "./context";
import {
  type NestedWriteStep,
  type RelationExecutor,
  type RelationStrategy,
  attachRelations,
} from "./compile/plan-relations";
import { resolveStrategy } from "./compile/strategy";
import { matchUniqueKey } from "./compile/unique";
import { upsertAbsentConflictKey } from "./compile/write";
import { dialectFor, type SqlDialect } from "./dialect";
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
  markPreScoped,
  policiesFor,
  policyContext,
  type ModelPolicy,
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

    const updated = await this.$exec("update", {
      where: record.key,
      data: changed,
    });

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
    track(instance, schema, []);

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
   */
  static transaction<T>(fn: () => Promise<T>): Promise<T> {
    return withTransaction(app(DatabaseManager).sql, () => fn());
  }

  static async $exec(
    op: Operation,
    args: any = {},
    options?: ExecOptions,
  ): Promise<unknown> {
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
    if (!system) {
      const registered = registry.has(schema.name)
        ? registry.get<unknown>(schema.name)
        : undefined;

      if (registered !== undefined && registered !== this) {
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
        op,
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

    if (policies.length > 0 && !preScoped) {
      // Deny-by-default lives on the context's `user` accessor, not here: a
      // policy that never consults the user — a soft-delete scope, say — has
      // nothing to deny and must keep working with no request in sight. See
      // `policyContext`.
      policy = policyContext(schema.name, op, currentUser(), system);
      effective = applyPolicies(policies, policy, args);
    }

    // Which strategy plans the include tree. Named per call or chosen by
    // `defaultStrategy`, and either way it reaches the plan key — two strategies
    // emit different SQL for the same arguments, so sharing a plan between them
    // would run one request's statement for the other's.
    const strategy = resolveStrategy(options?.strategy, dialect);

    // `upsert` whose `create` does not set the conflict key, which used to raise.
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
    // The divertable set comes from `upsertAbsentConflictKey`, the same function
    // the compiler refuses on, so the two cannot disagree about which calls
    // belong on which path.
    if (op === "upsert" && findThenWrite(schema, effective, op)) {
      const { where, create, update, ...projection } = effective;

      return withTransaction(db.sql, async () => {
        const found = await this.$exec(
          "findFirst",
          { where },
          markPreScoped({ strategy: options?.strategy }) as never,
        );

        return found === null
          ? await this.$exec(
              "create",
              { data: create, ...projection },
              markPreScoped({ strategy: options?.strategy }) as never,
            )
          : await this.$exec(
              "update",
              { where, data: update, ...projection },
              markPreScoped({ strategy: options?.strategy }) as never,
            );
      });
    }

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
        return withTransaction(db.sql, async () => {
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
      exec: (model, operation, relationArgs, preScoped) =>
        registry
          .get<typeof Model>(model)
          .$exec(
            operation as Operation,
            relationArgs,
            (preScoped
              ? markPreScoped({ strategy: options?.strategy })
              : { strategy: options?.strategy }) as never,
          ),
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
    //   A policy that varies by `context.operation` therefore sees "delete" for
    //   the children of a row being deleted, which is the conservative reading:
    //   these are the rows the delete is about to remove.
    //
    // Only when there is something to read. A plain `delete` still compiles to
    // one statement and opens no transaction.
    if (op === "delete" && plan.relations !== undefined) {
      const { where } = effective;
      const projection =
        effective.select !== undefined
          ? { select: effective.select }
          : { include: effective.include };

      // The pool, not `conn`: when a transaction is already open `withTransaction`
      // savepoints against the ambient handle and ignores this argument, and
      // passing a transaction handle here would read as though we begin on it.
      return withTransaction(db.sql, async () => {
        const before = await this.$exec(
          "findFirst",
          { where, ...projection },
          markPreScoped({ strategy: options?.strategy }) as never,
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
      const relationKeys = (plan.relations ?? []).map((relation) => relation.as);
      for (const row of rowsOf(result)) track(row, schema, relationKeys);
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
    const key = matchUniqueKey(schema, args?.where, op);
    return upsertAbsentConflictKey(schema, args, key).length > 0;
  } catch {
    return false;
  }
}
