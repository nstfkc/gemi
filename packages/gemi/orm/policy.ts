import { RequestContext } from "../http/requestContext";
import { currentActor } from "./context";
import { PolicyDeniedError, UnsupportedQueryError } from "./errors";
import type { Operation } from "./plan";
import type { ModelSchema } from "./schema";

/**
 * Per-model policies: deny an operation, scope its `where`, or redact fields —
 * applied to **every** query, including every nested relation read.
 *
 * The second of the two features that justify the project. Prisma's query
 * extensions do not fire on nested reads, so a scope written for `Account` is
 * bypassed by `User.findMany({ include: { accounts: true } })`. Ours is not,
 * and not because it takes care to cover that case: a relation read *is*
 * `$exec` on the related model's own class (invariant 1), so it goes through
 * the same hook as a root query and there is no second path to keep in step.
 *
 * Two rules the rest of this file exists to enforce:
 *
 * **Args in, args out.** A policy never sees SQL. It receives the plain
 * argument tree and returns a plain argument tree, before compilation. That is
 * what makes a scope a two-line `AND` instead of string surgery, what keeps the
 * relation strategies interchangeable — iteration 7's lateral joins put the
 * scoped `where` inside the subquery with no policy change — and what keeps the
 * plan cache sound.
 *
 * **Policies run before the plan key is computed.** They change the SQL, so a
 * plan keyed on the pre-policy args would let two differently-scoped users
 * share one plan. That is a cross-tenant data leak produced by a caching bug,
 * which is why the ordering is asserted by a test rather than left to the
 * pipeline's shape.
 */

export interface PolicyContext {
  /**
   * The authenticated user.
   *
   * Read synchronously off the request store — no `await` anywhere on this
   * path, because the hook runs per query *per relation node* and an awaited
   * user would be a round trip per node. A route without the `auth` middleware
   * therefore sees no user even when a cookie is present, which is the correct
   * reading: the route did not ask to authenticate.
   *
   * **Reading this when there is no user raises `PolicyDeniedError`.** That is
   * where deny-by-default actually lives, and it is deliberately here rather
   * than as an up-front check on the model: a policy that never consults the
   * user has nothing to deny. `softDeletes()` scopes on `deletedAt: null` and
   * is a data-integrity rule, not an authorization one — it must keep working
   * in a cron tick, a queue worker and a seed script. An up-front "this model
   * has a policy, so it needs a user" check made it unusable outside a request,
   * which was wrong.
   *
   * Raising on *access* rather than returning null is what keeps it safe: a
   * scope built from a null user would be `{ organizationId: undefined }`, and
   * Prisma treats an undefined value as an absent filter — so the scope would
   * silently vanish and the read would be unscoped. The leak, in other words,
   * is the quiet version of this error.
   *
   * Check {@link hasUser} first if a policy genuinely wants to handle both.
   */
  readonly user: unknown;
  /**
   * Whether there is a user to read, for a policy that wants to branch rather
   * than raise — a scope that differs for anonymous access, say.
   */
  readonly hasUser: boolean;
  /** The operation being performed, so a policy can vary by it. */
  readonly operation: Operation;
  /** The model the policy is attached to. */
  readonly model: string;
}

/**
 * Builds the context a policy sees, with `user` as an accessor that enforces
 * deny-by-default at the moment of use.
 *
 * `system` suppresses the raise, because `Model.asSystem` has already said this
 * code is not acting for anybody — a policy under it reading `user` gets
 * `null` rather than an error, which is what lets a policy written for requests
 * be reused by a script without rewriting it.
 */
export function policyContext(
  model: string,
  operation: Operation,
  user: unknown,
  system: boolean,
): PolicyContext {
  const context = { model, operation, hasUser: user !== null } as {
    model: string;
    operation: Operation;
    hasUser: boolean;
    user: unknown;
  };

  Object.defineProperty(context, "user", {
    enumerable: true,
    get() {
      if (user === null && !system) {
        throw new PolicyDeniedError(model, operation, "no-user");
      }
      return user;
    },
  });

  return context as PolicyContext;
}

/**
 * What a model contributes. Every member is optional; a model with none is
 * unpolicied and pays a single `undefined` check per query.
 */
export interface ModelPolicy {
  /**
   * Runs first, and may throw to deny outright. Return `false` to deny with the
   * framework's own message.
   */
  before?(context: PolicyContext): boolean | void;

  /**
   * Rewrites the argument tree. The one thing an extension cannot do.
   *
   * Returns a `where` fragment that is `AND`ed into `args.where` — not a
   * replacement for it, so a caller's own filters always still apply and a
   * policy can only ever *narrow*. Returning `undefined` means no scope.
   */
  scope?(context: PolicyContext): unknown;

  /**
   * Defaults or validates the payload of a `create`. Separate from `scope`
   * because the read semantics genuinely do not generalise: there is no `where`
   * on an insert, and "restrict which rows are affected" has no meaning for one
   * that does not exist yet. Receives and returns plain `data`.
   */
  onCreate?(context: PolicyContext, data: any): any;

  /**
   * Removes fields from a row after it is fetched. Runs in the shaping stage.
   *
   * The one policy capability that deliberately makes gemi's result differ from
   * Prisma's, so the differential harness must compare against the
   * *pre-redaction* payload. It also has a type-honesty problem — the generated
   * type says the field is there — which is why `redactable` below restricts it.
   */
  redact?(context: PolicyContext, row: any): void;
}

/** A model class carrying an optional policy, as seen from here. */
export interface PolicedModel {
  $policy?: ModelPolicy;
  $schema?: ModelSchema;
}

/**
 * Which operations have a `where` for `scope` to narrow.
 *
 * `upsert` is deliberately absent: its `where` compiles to an `on conflict`
 * target, which is a key rather than a predicate, and iteration 4 already
 * refuses a `where` carrying anything beside that key. A scoped upsert is
 * therefore not expressible at all, and is refused by name rather than run
 * unscoped — see `assertScopable`.
 */
const SCOPABLE = new Set<string>([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/** Operations whose `data` an `onCreate` applies to. */
const CREATING = new Set<string>(["create", "createMany", "upsert"]);

/**
 * Operations that write a new row and have no `where` at all, so a `scope`
 * cannot apply to them even in principle. `upsert` is not here: it *has* a
 * where, it just cannot carry a predicate — a different problem with a
 * different message.
 */
const INSERTING = new Set<string>(["create", "createMany"]);

/**
 * Every policy that applies to a model class, base first.
 *
 * Walks the prototype chain so a `TenantModel` or `SoftDeletes` base
 * contributes to every subclass. The order is **base to derived**, and it is
 * chosen rather than incidental: a subclass's `scope` is `AND`ed after its
 * base's, so a base can only ever be narrowed further, never widened. A derived
 * policy that could drop its base's scope would make a shared tenant guard
 * unenforceable, which is the opposite of why a base class would carry one.
 *
 * `Object.hasOwn` rather than a property read: an inherited `$policy` would
 * otherwise be collected once per level of the chain.
 */
export function policiesFor(model: unknown): ModelPolicy[] {
  const found: ModelPolicy[] = [];

  let current = model as PolicedModel | null;
  while (current && current !== Function.prototype) {
    if (Object.hasOwn(current, "$policy") && current.$policy) {
      // Unshifted, so the walk's derived-to-base order comes back base-first.
      found.unshift(current.$policy);
    }
    current = Object.getPrototypeOf(current);
  }

  return found;
}

/**
 * Applies every policy to the argument tree, returning a new tree.
 *
 * The caller's `args` is never mutated: a policy that rewrote it in place would
 * leave the mutation visible to the caller's own object, and — worse — would
 * apply a second time if the same args object were reused for a second call.
 */
export function applyPolicies(
  policies: readonly ModelPolicy[],
  context: PolicyContext,
  args: any,
): any {
  if (policies.length === 0) return args;

  let out = args;

  for (const policy of policies) {
    if (policy.before) {
      const verdict = policy.before(context);
      if (verdict === false) {
        throw new PolicyDeniedError(context.model, context.operation);
      }
    }
  }

  for (const policy of policies) {
    if (!policy.scope) continue;

    // An insert has no `where`, so there is nothing for a scope to narrow —
    // `onCreate` is the mechanism there. Skipping silently is only safe when the
    // policy has actually said how creates work; a `scope` with no `onCreate` is
    // an author who expressed an intent this operation cannot honour, and
    // running it would write a row into whatever tenant the caller named.
    if (INSERTING.has(context.operation)) {
      assertCreateCovered(policies, context);
      continue;
    }

    const scope = policy.scope(context);
    if (scope === undefined || scope === null) continue;

    assertScopable(context);
    out = withScope(out, scope);
  }

  if (CREATING.has(context.operation)) {
    for (const policy of policies) {
      if (policy.onCreate) out = withCreated(out, context, policy);
    }
  }

  return out;
}

/**
 * Adds a policy's fragment to `args.where` as an extra `AND` member, **beside**
 * the caller's own keys rather than wrapping them.
 *
 * Two requirements pull in opposite directions here, and getting either wrong is
 * silent:
 *
 * 1. The scope must not *replace* a caller's filter on the same field, which
 *    rules out merging keys. `{ organizationId: 9 }` scoped by
 *    `{ organizationId: 7 }` has to mean "both", i.e. no rows.
 * 2. The caller's top-level keys must stay at the top level, because
 *    `matchUniqueKey` reads them there. This is the one the obvious
 *    implementation gets wrong: `{ AND: [caller, scope] }` is semantically
 *    correct SQL and it hides `{ id: 1 }` one level down, so **every scoped
 *    `update` and `delete` fails** with "update needs a unique field". Found by
 *    the soft-delete tests, and one earlier test was passing for the wrong
 *    reason because of it — it expected a throw and got the wrong throw.
 *
 * `{ ...caller, AND: [...callersOwnAND, scope] }` satisfies both: `AND` is a
 * sibling key in Prisma's `where` grammar and `compileWhere` treats it as one,
 * so the scope is conjoined without moving anything the caller wrote.
 */
function withScope(args: any, scope: unknown): any {
  const where = args?.where;

  if (where === undefined || where === null) {
    return { ...args, where: scope };
  }

  if (typeof where !== "object" || Array.isArray(where)) {
    return { ...args, where: { AND: [where, scope] } };
  }

  // The caller may already have an `AND`, as an array or a bare object.
  const existing = where.AND;
  const members =
    existing === undefined || existing === null
      ? []
      : Array.isArray(existing)
        ? existing
        : [existing];

  return { ...args, where: { ...where, AND: [...members, scope] } };
}

/** Runs an `onCreate` over whichever shape the operation's payload takes. */
function withCreated(args: any, context: PolicyContext, policy: ModelPolicy): any {
  const run = (data: any) => policy.onCreate!(context, data ?? {});

  if (context.operation === "createMany") {
    const rows = args?.data;
    return {
      ...args,
      data: Array.isArray(rows) ? rows.map(run) : run(rows),
    };
  }

  if (context.operation === "upsert") {
    // Only the insert branch. The update branch is an update, and giving it a
    // create's defaults would overwrite columns on an existing row.
    return { ...args, create: run(args?.create) };
  }

  return { ...args, data: run(args?.data) };
}

/**
 * Refuses a `create` whose policy scopes reads but says nothing about writes.
 *
 * The natural tenant policy carries both `scope` and `onCreate`, and for it this
 * is a no-op. The dangerous shape is `scope` alone: reads are confined to the
 * caller's tenant and an insert can name any tenant it likes, which is a policy
 * that looks complete and is half of one. Refused with the missing piece named.
 */
function assertCreateCovered(
  policies: readonly ModelPolicy[],
  context: PolicyContext,
): void {
  if (policies.some((policy) => policy.onCreate)) return;

  throw new UnsupportedQueryError(
    context.operation,
    context.model,
    context.operation,
    `${context.model} has a policy that scopes reads but no 'onCreate', and ` +
      `${context.operation} has no where clause for a scope to narrow. As ` +
      `written the policy would confine reads to the caller and let an insert ` +
      `name any value it likes. Add an onCreate that sets the scoped ` +
      `column — or, if unscoped creates are intended, say so with an onCreate ` +
      `that returns its data unchanged.`,
  );
}

/**
 * Refuses an operation a scope cannot be applied to, rather than running it
 * unscoped.
 *
 * Only `upsert` reaches this. Its `where` becomes an `on conflict` target,
 * which takes a key and not a predicate — so there is nowhere for
 * `organizationId: 7` to go, and silently dropping it would mean a policied
 * model writing across a tenant boundary. Use `update` and `create`, both of
 * which scope normally.
 */
function assertScopable(context: PolicyContext): void {
  if (SCOPABLE.has(context.operation)) return;

  throw new UnsupportedQueryError(
    context.operation,
    context.model,
    context.operation,
    `${context.model} has a policy with a scope, and ${context.operation} ` +
      `cannot carry one: its where clause compiles to an 'on conflict' target, ` +
      `which is a key rather than a filter. Running it would write outside the ` +
      `scope. Use update and create separately, which both scope normally.`,
  );
}

/**
 * Applies every `redact` to every returned row, in place.
 *
 * In the shaping stage rather than the compiler, because it is the one policy
 * capability that is genuinely about the *result* — a redacted column is still
 * selected and still read, it just does not survive to the caller. Doing it by
 * dropping the column from the `select` instead would change the SQL, and so
 * the plan key, per user.
 */
export function applyRedaction(
  policies: readonly ModelPolicy[],
  context: PolicyContext,
  result: unknown,
): void {
  if (policies.length === 0) return;

  const redactors = policies.filter((policy) => policy.redact);
  if (redactors.length === 0) return;

  for (const row of rowsOf(result)) {
    for (const policy of redactors) policy.redact!(context, row);
  }
}

function rowsOf(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [];
  return [result];
}

/**
 * A `redact` helper that refuses to lie about the type.
 *
 * Redaction's problem is that the generated type says the field is there and
 * the value is gone, so `user.password.length` type-checks and throws. Limiting
 * it to *nullable* fields makes the runtime value one the type already allows,
 * which turns a lie into a narrowing. A non-nullable field is refused by name
 * rather than silently redacted, so the type-honesty decision is made once here
 * instead of per policy.
 *
 * A policy that genuinely needs to drop a non-nullable field can still `delete`
 * the key in its own `redact` — this is the guard rail, not a cage.
 */
export function redactNullable(
  schema: ModelSchema,
  row: any,
  fields: readonly string[],
): void {
  for (const name of fields) {
    const field = schema.fields[name];

    if (field && !field.nullable) {
      throw new UnsupportedQueryError(
        `redact.${name}`,
        schema.name,
        "redact",
        `'${name}' is not nullable, so setting it to null would contradict ` +
          `the generated type — which still says the field is there. Make the ` +
          `field optional in schema.prisma, omit it with 'select' instead, or ` +
          `delete the key yourself if a runtime-only guarantee is enough.`,
      );
    }

    if (name in row) row[name] = null;
  }
}

/**
 * The authenticated user for the current async scope, or `null`.
 *
 * Read **synchronously** off the request store, which is the decision that
 * shapes this whole hook. `Auth.user()` is the fuller answer — it falls back to
 * the cookie and resolves a session from the database — but it is `async`, and
 * this runs once per query *per node of an include tree*. An awaited user there
 * is a round trip per node on every request, for a value that is already sitting
 * in the store on any route that authenticated.
 *
 * The consequence, stated rather than discovered: a route without the `auth`
 * middleware sees `null` even when the request carries a valid cookie. That is
 * the correct reading — the route did not ask to authenticate — but it makes
 * middleware configuration load-bearing for data access, so under
 * deny-by-default a policied model on an unauthenticated route raises rather
 * than reading unscoped.
 *
 * The import is deliberately narrow. `http/requestContext.ts` pulls in no
 * runtime the ORM does not already have, and taking the store rather than the
 * `Auth` facade keeps `AuthManager` — and its user provider, and its database
 * queries — off this path entirely.
 */
export function currentUser(): unknown {
  // An explicit actor wins over the ambient request. A job that has said who it
  // is acting as must not be quietly re-scoped by a request that happens to
  // enclose it — and in a test, that is the only user there is.
  const actor = currentActor();
  if (actor) return actor.user;

  // `RequestContext.getStore()` is non-null-asserted at its definition, so it
  // is `undefined` rather than a throw outside a request. Cron ticks, queue
  // workers and CLI never enter it; that case is the null.
  return requestStore()?.user ?? null;
}

function requestStore(): { user?: unknown } | undefined {
  try {
    return RequestContext.getStore() as { user?: unknown } | undefined;
  } catch {
    // Defensive: the accessor's non-null assertion is a type-level claim, not a
    // runtime guard, but a future change to it must not turn "no request" into
    // a crash on every ORM query.
    return undefined;
  }
}
