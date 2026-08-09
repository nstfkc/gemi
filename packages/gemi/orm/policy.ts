import { RequestContext } from "../http/requestContext";
import { currentActor } from "./context";
import {
  InvalidPolicyEntryError,
  PolicyDeniedError,
  ScopeEscapeError,
  UnsupportedQueryError,
} from "./errors";
import type { Operation } from "./plan";
import {
  COUNT_KEY,
  isOperatorForm,
  relationFilterOperators,
} from "./relation-filters";
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
  // `!= null` and `== null` below, not `!==` / `===`. `user` is `unknown` and
  // arrives verbatim from `Model.asUser`, so `undefined` is reachable —
  // `asUser(usersById.get(job.userId), ...)` on a miss, which is exactly the
  // "user failed to turn up" case deny-by-default exists for. Strict equality
  // let it through: `hasUser` said true and the accessor did not raise, so a
  // scope reading `ctx.user?.organizationId` collapsed to `{}` — an *absent*
  // filter — and returned every tenant's rows. The request path normalises with
  // `?? null` and so never produced it, which is why only `asUser` could.
  const context = { model, operation, hasUser: user != null } as {
    model: string;
    operation: Operation;
    hasUser: boolean;
    user: unknown;
  };

  Object.defineProperty(context, "user", {
    enumerable: true,
    get() {
      if (user == null && !system) {
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
export interface ModelPolicy<TWhere = any, TCreate = any, TRow = any> {
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
  scope?(context: PolicyContext): TWhere | undefined;

  /**
   * Defaults or validates the payload of a `create`. Separate from `scope`
   * because the read semantics genuinely do not generalise: there is no `where`
   * on an insert, and "restrict which rows are affected" has no meaning for one
   * that does not exist yet. Receives and returns plain `data`.
   */
  onCreate?(context: PolicyContext, data: TCreate): TCreate;

  /**
   * The same job for an `update`, and the reason it is a separate hook rather
   * than something `scope` covers.
   *
   * A scope narrows *which rows* an update may touch. It says nothing about the
   * values being written — so a tenant-scoped model could only ever update its
   * own rows, and could set `organizationId` on one of them to any tenant it
   * liked. Read-scoped, write-open: the row leaves the caller's scope and cannot
   * be read back, which makes it a one-way door rather than a visible error.
   *
   * That is the same hole `onCreate` exists to close, arriving through `data`
   * instead of through a missing `where`, and `plans/orm/06-policies.md` §5 asked
   * for exactly this — "define what `scope` means per operation rather than
   * assuming the read semantics generalise" — for every write. It was answered
   * for `create` and `delete` and left open for `update`.
   *
   * Receives and returns plain `data`. A policy that does not define it is not
   * penalised on ordinary updates; it is only required when an update actually
   * names a column the policy's own scope constrains. See `assertNoScopeEscape`.
   */
  onUpdate?(context: PolicyContext, data: Partial<TCreate>): Partial<TCreate>;

  /**
   * Removes fields from a row after it is fetched. Runs in the shaping stage.
   *
   * The one policy capability that deliberately makes gemi's result differ from
   * Prisma's, so the differential harness must compare against the
   * *pre-redaction* payload.
   *
   * `Partial<TRow>` rather than `TRow`, because redaction's whole problem is that
   * it makes the generated type a lie — the type says the field is there and the
   * value is gone. A `redact` also runs over rows shaped by a `select`, where
   * most fields genuinely are absent. `redactNullable` is the guard rail that
   * keeps the lie out of the *caller's* type; this keeps it out of the policy's.
   */
  redact?(context: PolicyContext, row: Partial<TRow>): void;
}

/**
 * A policy as it may be written in a `$policies` array: the object itself, or a
 * class to be instantiated once.
 *
 * Both forms are accepted because neither dominates. A class gets contextual
 * *return* checking against {@link Policy} and — through {@link ScopedPolicy} —
 * lets `scope`/`onCreate`/`onUpdate` be abstract members, so the pairing this
 * file otherwise enforces at runtime becomes a compile error. An object comes
 * out of a factory, which is the only form that can carry configuration and be
 * reused across models: `softDeletes<User>({ field })` cannot be a bare
 * constructor, because a constructor in an array has nowhere to put arguments
 * or type parameters.
 */
export type PolicyEntry<TWhere = any, TCreate = any, TRow = any> =
  | ModelPolicy<TWhere, TCreate, TRow>
  | (new () => ModelPolicy<TWhere, TCreate, TRow>);

/**
 * The optional base class for the class-authoring form.
 *
 * The members are declared through an interface merged with the class rather
 * than in the class body, and that is not a style choice. A class *field*
 * declaration — `scope?: (ctx) => T` — emits `Object.defineProperty(this,
 * "scope", { value: undefined })` under `useDefineForClassFields`, which is the
 * default at this target. That own property would shadow the derived class's
 * prototype method and every policy written this way would silently do nothing.
 * Declaration merging gives the instance type the same members and emits no
 * field at all.
 *
 * Extending this is optional in both directions: a plain object satisfies
 * `ModelPolicy` structurally, and an instance of a subclass satisfies it the
 * same way. Nothing in the runtime checks for it.
 *
 * Note what it does *not* buy: TypeScript never contextually types an
 * overriding method's parameters from its base, so `scope(ctx)` in a subclass is
 * an implicit `any`. Write `scope(ctx: PolicyContext)`. What it does buy is the
 * return type being checked against the model's `WhereInput`.
 */
// Both suppressions are the merge described above, seen from the linter's side.
//
// `no-unsafe-declaration-merging` fires because merging a class with an
// interface lets the interface claim members the constructor never initialises.
// That is exactly what is wanted here and it is safe for the same reason the
// generated model bases' merge is: every member is optional, so "not
// initialised" is a value the type already permits. The unsafe version of this
// pattern declares *required* members.
//
// `no-unused-vars` fires because the type parameters appear only on the
// interface half. Dropping them from the class is not an option — `ScopedPolicy`
// extends it with the same three — and renaming them to `_TWhere` would put the
// underscores in every author's hover text.
// oxlint-disable-next-line typescript-eslint/no-unsafe-declaration-merging, eslint/no-unused-vars
export abstract class Policy<TWhere = any, TCreate = any, TRow = any> {}
export interface Policy<TWhere = any, TCreate = any, TRow = any>
  extends ModelPolicy<TWhere, TCreate, TRow> {}

/**
 * A policy that scopes, with the write halves made mandatory by the type system.
 *
 * `assertCreateCovered` and `assertNoScopeEscape` enforce this at runtime, and
 * have to: an object literal can always omit a key. Extending this class moves
 * the same rule to compile time for the authors who want it — a missing
 * `onCreate` becomes `TS2515` at the class declaration rather than an error on
 * the first `create` that reaches production.
 */
export abstract class ScopedPolicy<
  TWhere = any,
  TCreate = any,
  TRow = any,
> extends Policy<TWhere, TCreate, TRow> {
  abstract scope(context: PolicyContext): TWhere | undefined;
  abstract onCreate(context: PolicyContext, data: TCreate): TCreate;
  abstract onUpdate(
    context: PolicyContext,
    data: Partial<TCreate>,
  ): Partial<TCreate>;
}

/** A model class carrying optional policies, as seen from here. */
export interface PolicedModel {
  $policies?: readonly PolicyEntry[];
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
 *
 * **Every other operation with a `where` has to be in here, and adding one is
 * the step that is easy to forget.** `assertScopable` is written for `upsert`,
 * so an operation missing from this set does not run unscoped — it fails, with
 * `upsert`'s reason about `on conflict` targets, which sends the reader
 * somewhere unrelated. That is the safe direction and a confusing one, and it
 * takes the operation away from exactly the models the ORM's headline
 * capability is for: anything carrying `softDeletes()` has a `scope`.
 */
const SCOPABLE = new Set<string>([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  // Its `where` is an ordinary predicate over the rows being aggregated, so a
  // scope narrows it exactly as it narrows a `count` — which is the same
  // statement with one function in it.
  "aggregate",
  // Same reasoning one step further: its `where` filters the rows *before* they
  // are grouped, so a scope narrows which rows any group can contain. Leaving
  // it out would not merely refuse the operation — `assertScopable` raises — so
  // every policied model would lose `groupBy` entirely, which is how `aggregate`
  // was found missing on #74.
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/** Operations whose `data` an `onCreate` applies to. */
const CREATING = new Set<string>(["create", "createMany", "upsert"]);

/**
 * Operations whose payload an `onUpdate` applies to. `upsert` is here and absent
 * from {@link UPDATING} below for the same reason it is in `CREATING`: it has an
 * update payload to default, but a scope can never reach it (see
 * `assertScopable`), so there is nothing for the scope-escape guard to check.
 */
const MUTATING = new Set<string>(["update", "updateMany", "upsert"]);

/**
 * Operations that write to existing rows *and* carry a scope, so an update can
 * move a row out of the scope that selected it.
 */
const UPDATING = new Set<string>(["update", "updateMany"]);

/**
 * Operations that write a new row and have no `where` at all, so a `scope`
 * cannot apply to them even in principle. `upsert` is not here: it *has* a
 * where, it just cannot carry a predicate — a different problem with a
 * different message.
 */
const INSERTING = new Set<string>(["create", "createMany"]);

/**
 * Instances made from constructor entries, so identity is stable across calls.
 *
 * Not an optimisation. `$exec`'s divergence guard and `assertPoliciesRegistered`
 * both compare two policy chains element by element, and a fresh instance per
 * call would make every comparison fail — every query on a class-form policy
 * would raise `UnregisteredPolicyClassError` against itself. Keyed on the
 * constructor, which is as stable as the class object.
 *
 * Keyed on the constructor and nothing else, so a policy class listed in two
 * models' `$policies` is **one instance shared across both** — once per process,
 * not once per model. Correct for every policy that exists today, all of which
 * are stateless, and the reason the class form is documented as a place for
 * behaviour rather than for state: a policy that memoised anything per model
 * would silently serve one model's cache to the other. A policy that genuinely
 * needs per-model state should be a factory returning a fresh object, which is
 * what `PolicyEntry`'s other half is for.
 */
const instantiated = new WeakMap<object, ModelPolicy>();

/**
 * Turns one `$policies` entry into the object the hooks are read off.
 *
 * Takes the declaring class's name and the entry's index so that **everything
 * construction can go wrong with is named**. `assertPolicyEntries` has already
 * proved a function entry constructable, which is a fact about `[[Construct]]`
 * and says nothing about the body: a class whose constructor takes a required
 * argument is perfectly constructable and dies inside `new` with
 * `TypeError: undefined is not an object (evaluating 'opts.field')`. That is
 * #321's case A3, it is the shape the issue's own `not-constructable` advice was
 * written for, and it reaches here rather than the check — so the `try` is not
 * defensive, it is the third of the three cases.
 *
 * The hook check for the class form is here too, and can only be here: a policy
 * class keeps its hooks on a prototype, or assigns them in the constructor, so
 * there is nothing to read until an instance exists.
 */
function resolveEntry(
  entry: PolicyEntry,
  owner: unknown,
  index: number,
): ModelPolicy {
  if (typeof entry !== "function") return entry;

  const existing = instantiated.get(entry);
  if (existing !== undefined) return existing;

  let made: ModelPolicy;
  try {
    made = new (entry as new () => ModelPolicy)();
  } catch (cause) {
    throw new InvalidPolicyEntryError(
      nameOfOwner(owner),
      index,
      "constructor-threw",
      `${describeFunction(entry)}, and constructing it threw:\n\n    ` +
        `${(cause as Error)?.message ?? String(cause)}`,
      RECOGNISED_HOOKS,
      undefined,
      { cause },
    );
  }

  assertHasCallableHook(made as Record<string, unknown>, owner, index);

  instantiated.set(entry, made);
  return made;
}

/** One level's entries resolved, each knowing where it was written. */
function resolveLevel(
  entries: readonly PolicyEntry[],
  owner: unknown,
): ModelPolicy[] {
  return entries.map((entry, index) => resolveEntry(entry, owner, index));
}

/**
 * The hooks the runtime actually dispatches on, in the order it consults them.
 *
 * `applyPolicies` reads the first four and `applyRedaction` the fifth. An entry
 * that spells none of them contributes nothing to any query, which is the whole
 * of case B in #321 — so this list is the definition of "a policy that would
 * run", and it has to stay the same list.
 *
 * **Adding a hook to {@link ModelPolicy} without adding it here is a compile
 * error**, by the assertion below. That direction is the dangerous one: a new
 * hook missing from this list would make an entry carrying only that hook look
 * like a typo and be refused at boot — a working policy rejected — which is
 * exactly the over-strictness this guard must not produce. The other direction
 * is checked too, so a name removed from `ModelPolicy` cannot linger here and go
 * on being accepted.
 *
 * **The pin is over `ModelPolicy`'s *callable* members, not over `keyof`**, and
 * that distinction is load-bearing rather than fussy. Entries in this list are
 * required to be functions — `hook-not-callable` refuses anything else — so a
 * `keyof` pin would force a future non-function member (`priority?: number`,
 * `appliesTo?: string[]`) into the list to satisfy the compiler, and every entry
 * that then set it would be refused at boot. A data member simply is not a hook:
 * it is left out, it is not required to be callable, and it does not on its own
 * make an entry one that would run.
 */
const RECOGNISED_HOOKS = [
  "before",
  "scope",
  "onCreate",
  "onUpdate",
  "redact",
] as const;

/** The members of `T` whose value, when present, is callable. */
type CallableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof T];

type _MissingHook = Exclude<
  CallableKeys<ModelPolicy>,
  (typeof RECOGNISED_HOOKS)[number]
>;
type _ExtraHook = Exclude<
  (typeof RECOGNISED_HOOKS)[number],
  CallableKeys<ModelPolicy>
>;

// Assigning `true` is what fails: either branch resolves to a string literal
// type when the two lists disagree, and the message is the diagnostic.
const _hooksExhaustive: [_MissingHook] extends [never]
  ? [_ExtraHook] extends [never]
    ? true
    : "RECOGNISED_HOOKS names something ModelPolicy does not declare as a callable member"
  : "ModelPolicy declares a callable member RECOGNISED_HOOKS does not list — an entry carrying only that hook would be refused at boot" =
  true;
void _hooksExhaustive;

/**
 * Entry arrays already checked, so the guard costs one lookup per contributing
 * level per call rather than a walk of every entry.
 *
 * Keyed on the **array** and not on the entries, because that is the granularity
 * the hot path already has: `policiesFor` runs per query per node of an include
 * tree, and `$policies` is an ordinary static that a test or a feature flag
 * reassigns — a reassignment produces a new array, which is unchecked and gets
 * checked. Mutating an array in place after it has been read once is the one
 * thing this does not re-examine, and it is not a shape anything writes.
 */
const checkedEntries = new WeakSet<readonly PolicyEntry[]>();

/**
 * Refuses a `$policies` entry that could not do what it was written to do,
 * naming the class, the index, and what was found there.
 *
 * Called from `policiesFor` once per contributing level, with `owner` being the
 * class that **declares** the array rather than the model being queried — so the
 * name in the message is the one the author typed the entry under, which on a
 * shared base is not the model whose query happened to reach it.
 *
 * One placement, and it is `policiesFor` rather than the audit the issue
 * proposed, because `policiesFor` is what every path already goes through:
 * `registerModels` at boot and `gemi check models` reach it through
 * `auditModelRegistrations`, and `Model.$exec` reaches it directly on a class
 * neither of those ever saw. Putting the check in the audit alone would leave
 * the crash live on the query path and leave the naming problem unsolved, since
 * the audit knows the model but not which level of the chain declared the array.
 */
function assertPolicyEntries(
  owner: unknown,
  entries: readonly PolicyEntry[],
): void {
  if (checkedEntries.has(entries)) return;

  for (let index = 0; index < entries.length; index++) {
    assertPolicyEntry(entries[index] as PolicyEntry, owner, index);
  }

  checkedEntries.add(entries);
}

/**
 * What can be known about an entry **without constructing it**.
 *
 * The split matters, and it is the reviewer's question answered rather than a
 * layering preference: this half runs at boot over every model class an
 * application declares, and constructing a policy class there would move
 * whatever its constructor touches — a config slice, an environment variable, a
 * service container — from first-query time to `registerModels` time. A class
 * that was fine because it was built lazily would take the app's boot with it,
 * and the entry it was refusing might have been perfectly good.
 *
 * So: an object entry is fully checkable here (case B is an object entry in both
 * of the shapes #321 reports), a function entry is checked for `[[Construct]]`
 * and nothing more, and the class form's hooks are checked in `resolveEntry`
 * where an instance exists because one was needed anyway.
 */
function assertPolicyEntry(
  entry: PolicyEntry,
  owner: unknown,
  index: number,
): void {
  const model = nameOfOwner(owner);
  const kind = typeof entry;

  // Arrays are refused here rather than falling through as objects. A nested
  // array is a plausible slip — `$policies = [[a, b]]` — and reading one as a
  // policy produced a message listing `length`, `concat`, `pop` and the rest of
  // `Array.prototype` as the keys it "spells".
  if (
    entry === null ||
    Array.isArray(entry) ||
    (kind !== "object" && kind !== "function")
  ) {
    throw new InvalidPolicyEntryError(
      model,
      index,
      "not-a-policy",
      describeValue(entry),
      RECOGNISED_HOOKS,
    );
  }

  if (kind === "function") {
    if (!isConstructable(entry as Function)) {
      throw new InvalidPolicyEntryError(
        model,
        index,
        "not-constructable",
        describeFunction(entry as Function),
        RECOGNISED_HOOKS,
      );
    }

    // Everything else about a class is a property of its instance.
    return;
  }

  assertHasCallableHook(entry as Record<string, unknown>, owner, index);
}

/**
 * The hook check itself, over a policy that already exists — an object entry, or
 * an instance `resolveEntry` has just built.
 *
 * A property read rather than `Object.keys`, so it walks the prototype chain and
 * sees a class's methods, an inherited hook, a getter and a `defineProperty`
 * alike. That is the whole reason the class form works at all.
 */
function assertHasCallableHook(
  policy: Record<string, unknown>,
  owner: unknown,
  index: number,
): void {
  const model = nameOfOwner(owner);
  let callable = 0;
  /** Hooks written down and left nullish — reported, so "it spells 'scope'"
   * beside "it has no scope" is not a contradiction the reader has to resolve. */
  const unset: string[] = [];

  for (const hook of RECOGNISED_HOOKS) {
    const value = policy[hook];
    // `undefined` and `null` are absence, not error: `{ scope: undefined }` is
    // what a conditionally-built policy leaves behind and `applyPolicies` skips
    // it exactly as it skips a key that was never written.
    if (value === undefined || value === null) {
      if (hook in policy) unset.push(hook);
      continue;
    }

    if (typeof value !== "function") {
      throw new InvalidPolicyEntryError(
        model,
        index,
        "hook-not-callable",
        `'${hook}' that is ${describeValue(value)} rather than a function`,
        RECOGNISED_HOOKS,
      );
    }

    callable++;
  }

  if (callable > 0) return;

  if (unset.length > 0) {
    throw new InvalidPolicyEntryError(
      model,
      index,
      "no-hooks",
      `It writes ${unset.map((hook) => `'${hook}'`).join(", ")} down and ` +
        `leaves ${unset.length === 1 ? "it" : "them"} unset, which reads as ` +
        `absent — so nothing is left to run.`,
      RECOGNISED_HOOKS,
    );
  }

  const spelled = spelledKeys(policy);
  const near = nearestHook(spelled);

  throw new InvalidPolicyEntryError(
    model,
    index,
    "no-hooks",
    spelled.length === 0
      ? "It is empty."
      : `It spells ${listKeys(spelled)}.` +
          // The other half of #321's case B, and it is not a misspelling, so
          // "did you mean" has nothing to offer it: an entry whose only key is
          // `default` is a module namespace — `import * as p` or a CJS interop
          // — put in the array instead of the policy inside it.
          (spelled.length === 1 && spelled[0] === "default"
            ? ` A lone 'default' is a module namespace rather than the policy ` +
              `inside it — put \`entry.default\` in the array, or import the ` +
              `policy by name.`
            : ""),
    RECOGNISED_HOOKS,
    near,
  );
}

/**
 * The keys, listed, with a ceiling.
 *
 * A policy-shaped object that happens to carry no hook can hold a great many
 * keys, and an error whose useful sentence is buried under forty of them is a
 * worse error than one that says "and 32 more".
 */
function listKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, 8).map((key) => `'${key}'`);
  return keys.length > shown.length
    ? `${shown.join(", ")} and ${keys.length - shown.length} more`
    : shown.join(", ");
}

/**
 * Whether `new value()` is a thing that can be written.
 *
 * The language exposes `[[Construct]]` nowhere directly, and every syntactic
 * proxy for it is wrong somewhere. `value.prototype === undefined` is the usual
 * one — true of arrow functions, method shorthand and `async` functions, which
 * are three of the four shapes a forgotten factory call takes — and it is also
 * true of `SomeClass.bind(null)`, which *is* constructable. Refusing that would
 * be the over-strict direction, where a policy somebody legitimately wrote stops
 * an app from booting. A generator function fails the other way: it has a
 * `prototype` and is not constructable.
 *
 * So the engine is asked outright. `Reflect.construct` validates `newTarget` as
 * a constructor **before** it runs the target's body, so putting the entry there
 * and a do-nothing constructor in the target position answers the question
 * without executing the policy's own constructor — which matters, because that
 * is user code and this runs at boot on every class in a declared module.
 */
function isConstructable(value: Function): boolean {
  try {
    Reflect.construct(NOOP, [], value as new () => unknown);
    return true;
  } catch {
    return false;
  }
}

/** The do-nothing target of the probe above. Its body is what does not run. */
const NOOP = function () {} as unknown as new () => unknown;

/**
 * The keys an entry spells, own and inherited, so the message can say what was
 * found. Prototype methods are included because the class form is where the
 * hooks live there; `Object.prototype` and `constructor` are not, because they
 * are not something the author wrote.
 */
function spelledKeys(policy: object): string[] {
  const keys = new Set<string>();

  let current: object | null = policy;
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key !== "constructor") keys.add(key);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return [...keys];
}

/**
 * The recognised hook a spelled key most plausibly meant, **with the key it is
 * about** — or nothing.
 *
 * Two things were wrong with the obvious version, and both produced a confident
 * suggestion to an author who had not misspelled anything.
 *
 * **The threshold was two edits.** `store` and `code` and `copy` are each two
 * from `scope`, and `reduce` is two from `redact` — all ordinary names for
 * things that sit beside a policy. One edit is what an actual typo costs
 * (`scopes`, `onCreat`), and case is free because the comparison is lowered
 * first, so `Scope` still lands. Anything further away is a guess, and this
 * error's whole subject is an authorization rule that is not in effect: a wrong
 * suggestion there sends someone to rename a key that was never the problem.
 *
 * **And it was reported unattributed.** "Did you mean `scope`?" after a list of
 * five keys does not say which of them it read as a misspelling, so it cannot be
 * dismissed by a reader who can see that none of them are. The pair travels
 * together now, and the error prints both.
 */
function nearestHook(
  spelled: readonly string[],
): { key: string; hook: string } | undefined {
  let best: { key: string; hook: string } | undefined;
  let bestDistance = 2;

  for (const key of spelled) {
    for (const hook of RECOGNISED_HOOKS) {
      const distance = editDistance(key.toLowerCase(), hook.toLowerCase());
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { key, hook };
      }
    }
  }

  return best;
}

/** Levenshtein, iterative over one row. Inputs here are hook names. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;

  let row = Array.from({ length: b.length + 1 }, (_value, index) => index);

  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const held = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = held;
    }
  }

  return row[b.length]!;
}

/**
 * A value as a message names it: what it is, not what it holds. Objects are not
 * stringified — `[object Object]` names nothing, and a policy's own data is not
 * something to print into a log line.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "function") return describeFunction(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `the ${typeof value} ${String(value)}`;
}

function describeFunction(value: Function): string {
  return value.name ? `the function \`${value.name}\`` : "an anonymous function";
}

/**
 * Every policy that applies to a model class, base first.
 *
 * Walks the prototype chain so a `TenantModel` or `SoftDeletes` base
 * contributes to every subclass, and concatenates each level's `$policies`.
 * The order is **base to derived**, and it is chosen rather than incidental: a
 * subclass's `scope` is `AND`ed after its base's, so a base can only ever be
 * narrowed further, never widened. A derived policy that could drop its base's
 * scope would make a shared tenant guard unenforceable, which is the opposite of
 * why a base class would carry one. Within one level, array order is the
 * author's and is preserved.
 *
 * `Object.hasOwn` rather than a property read: an inherited `$policies` would
 * otherwise be collected once per level of the chain.
 *
 * **Deliberately uncached.** This runs per query per node of an include tree, so
 * a cache is tempting — but `$policies` is an ordinary static that tests and
 * feature flags reassign at runtime, and a cache keyed on the class would serve
 * the stale chain with no way to notice. The single-level fast path below is
 * what keeps the common case free: one `Object.hasOwn` per level and no
 * allocation at all when nothing needs instantiating.
 */
export function policiesFor(model: unknown): readonly ModelPolicy[] {
  let found: ModelPolicy[] | undefined;
  let only: readonly PolicyEntry[] | undefined;
  // Held beside `only`, because the class that *declared* the held array is not
  // the one the walk is standing on by the time it gets resolved.
  let onlyOwner: unknown;

  let current = model as PolicedModel | null;
  while (current && current !== Function.prototype) {
    // The rename tripwire, and it earns its keep because the failure it catches
    // is silent in both directions: `Model` no longer declares `$policy`, so a
    // class still carrying it neither fails to compile nor gets read — the model
    // is simply unpolicied, and a tenant scope stops applying with nothing to
    // notice it. Every call site in this repository is migrated; the window this
    // covers is a branch rebased across the rename, or a stack still on the old
    // name. Same argument `UnregisteredPolicyClassError` makes one function over:
    // a policy that is present but not in effect has to be loud.
    //
    // Delete once `feat/orm` merges and nothing can still be carrying it.
    if (Object.hasOwn(current, "$policy")) {
      throw new Error(
        `${(current as { name?: string }).name ?? "This model"} declares ` +
          `\`$policy\`, which is now \`$policies\` and takes a list. The old ` +
          `name is not read, so this model is currently unpolicied — every ` +
          `scope, onCreate and redact on it is being skipped.`,
      );
    }

    if (Object.hasOwn(current, "$policies") && current.$policies) {
      const level = current.$policies;
      if (level.length > 0) {
        // Before anything is resolved, and with the declaring class in hand —
        // which is what lets the refusal say `ScopedAccount.$policies[0]`
        // instead of dying inside `new entry` with nothing named. Memoised on
        // the array, so the per-query cost is one `WeakSet.has` per level; the
        // class is passed rather than its name so that even reading `.name` is
        // something only a refusal pays for.
        const owner = current;
        assertPolicyEntries(owner, level);

        if (only === undefined && found === undefined) {
          // First contributing level, walking derived to base. Held rather than
          // copied, in case it turns out to be the only one — and the class that
          // declared it is held beside it, because `current` will have moved on
          // by the time the array is resolved.
          only = level;
          onlyOwner = owner;
        } else {
          // A second level exists, so the held one has to be materialised.
          // Unshifted, so the walk's derived-to-base order comes back
          // base-first.
          found ??= resolveLevel(only as readonly PolicyEntry[], onlyOwner);
          only = undefined;
          found.unshift(...resolveLevel(level, owner));
        }
      }
    }
    current = Object.getPrototypeOf(current);
  }

  if (found !== undefined) return found;
  if (only === undefined) return EMPTY;

  // The overwhelmingly common shape: policies on exactly one class. Returned
  // without copying when every entry is already an object, which is every
  // factory-authored policy.
  return only.some((entry) => typeof entry === "function")
    ? resolveLevel(only, onlyOwner)
    : (only as readonly ModelPolicy[]);
}

/**
 * Every `$policies` entry a model class carries, checked as far as it can be
 * **without constructing anything** — the boot-time half of #321's guard.
 *
 * `auditModelRegistrations` calls this for every model class in every declared
 * module, and that is the whole point: it is the one walk that sees a class
 * regardless of whether anything registered it, whether it registered itself, or
 * whether its name is claimed at all. `policiesFor` is only reached there for
 * the classes whose registration diverges, so the two commonest arrangements —
 * a class that owns its name, and a name nothing else claims — would boot with
 * their entries unexamined, which is exactly the `{ scopes: … }` typo shipping.
 *
 * **Shape only, deliberately.** The alternative was to resolve, which is one
 * line and would also catch a class whose constructor throws. It would also
 * construct every policy class in the application at `registerModels` time,
 * moving whatever a constructor touches — config, environment, a service
 * container — ahead of where it is wired. A guard against a policy that does
 * nothing must not be a reason a working application stops booting, so the
 * cases that need an instance wait for one to be needed.
 */
export function assertPolicyShapes(model: unknown): void {
  let current = model as PolicedModel | null;

  while (current && current !== Function.prototype) {
    // Note what is *not* here: the `$policy` rename tripwire that `policiesFor`
    // carries. It belongs to resolution, and firing it from a walk that reaches
    // strictly more classes would turn a first-query error into a boot failure
    // for models this function has no business having an opinion about.
    if (Object.hasOwn(current, "$policies") && current.$policies) {
      const level = current.$policies;
      if (level.length > 0) assertPolicyEntries(current, level);
    }
    current = Object.getPrototypeOf(current);
  }
}

function nameOfOwner(owner: unknown): string {
  return (owner as { name?: string })?.name ?? "This model";
}

const EMPTY: readonly ModelPolicy[] = Object.freeze([]);

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
  /**
   * Columns of `args.data` the ORM wrote rather than the caller — see
   * {@link ormAuthoredFields}. Only the scope-escape guard reads it.
   */
  ormAuthored: readonly string[] = [],
): any {
  if (policies.length === 0) return args;

  let out = args;

  /**
   * Scope-owned columns whose policy has no `onUpdate`, so nobody has said what
   * writing them should mean. Accumulated during the scope loop and checked once
   * at the end, against the payload as it will actually be written.
   */
  let unguarded: string[] | undefined;

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
      assertCreateCovered(policy, context);
      continue;
    }

    const scope = policy.scope(context);
    if (scope === undefined || scope === null) continue;

    assertScopable(context);

    // Collected from *this* policy's own fragment — only this iteration knows
    // what its scope constrains — but checked after the rewrites below rather
    // than here. See `unguarded` and `assertNoScopeEscape`.
    if (UPDATING.has(context.operation) && !policy.onUpdate) {
      const owned = scopeOwnedFields(scope);
      if (owned.length > 0) (unguarded ??= []).push(...owned);
    }

    out = withScope(out, scope);
  }

  if (CREATING.has(context.operation)) {
    for (const policy of policies) {
      if (policy.onCreate) out = withCreated(out, context, policy);
    }
  }

  if (MUTATING.has(context.operation)) {
    for (const policy of policies) {
      if (policy.onUpdate) out = withUpdated(out, context, policy);
    }
  }

  // **After the `onUpdate` pass, not before it**, and that ordering is the whole
  // point of hoisting the check out of the scope loop.
  //
  // Checking the caller's `data` where the fragment is computed is the obvious
  // placement and it leaves a gap the same shape as the `assertCreateCovered`
  // bug this guard was written alongside: one policy acting on another's behalf.
  // There it was a `some()` over the list; here it is the rewrite. A policy
  // carrying only an `onUpdate` can write a column that a *different* policy
  // scopes on, and if that policy has no `onUpdate` of its own then nobody has
  // taken responsibility for the column — yet the value lands anyway, because
  // the check already ran against a `data` that did not contain it.
  //
  //     [{ onUpdate: (_c, d) => ({ ...d, orgId: 999 }) },
  //      { scope: () => ({ orgId: 7 }) }]
  //
  // Running last means the question is asked of what will actually be written,
  // whoever put it there — which is the only version of the question worth
  // asking.
  if (unguarded !== undefined) {
    assertNoScopeEscape(unguarded, context, out, ormAuthored);
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
  // A shallow copy, so `applyPolicies`' promise that the caller's args are never
  // mutated is one the *mechanism* keeps rather than one every policy author has
  // to remember. The natural way to write an `onCreate` is
  // `data.organizationId = ...; return data`, and without the copy that mutates
  // the caller's object — which then applies a second time if the same args are
  // reused for another call, the exact hazard the promise cites. `redact` is
  // deliberately different: there the mutation *is* the interface.
  const run = (data: any) => policy.onCreate!(context, { ...data });

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
 * Runs an `onUpdate` over whichever shape the operation's payload takes.
 *
 * The same shallow copy as `withCreated`, for the same reason, and the same
 * split for `upsert` — there the update branch is `args.update` rather than
 * `args.data`, and the create branch is `onCreate`'s.
 */
function withUpdated(
  args: any,
  context: PolicyContext,
  policy: ModelPolicy,
): any {
  const key = context.operation === "upsert" ? "update" : "data";
  const payload = args?.[key];

  // Nothing to default. An `update` with no `data` is the compiler's error to
  // report, and manufacturing `{}` here would turn it into a silent no-op write.
  if (payload === undefined || payload === null) return args;

  return { ...args, [key]: policy.onUpdate!(context, { ...payload }) };
}

/**
 * Refuses an update whose payload writes a scope-owned column that no policy has
 * taken responsibility for.
 *
 * See {@link ScopeEscapeError} for what the shape is and why it is dangerous.
 * The check is deliberately narrow — it fires only when the payload actually
 * names such a column — so an ordinary `update({ data: { name } })` on a
 * tenant-scoped model costs one `Object.keys` and passes, and nobody has to
 * write an `onUpdate` they do not need.
 *
 * `unguarded` is already filtered to policies without an `onUpdate`: a policy
 * that has one owns its columns, and whatever it does with them is its business.
 */
function assertNoScopeEscape(
  unguarded: readonly string[],
  context: PolicyContext,
  args: any,
  /**
   * Columns the ORM itself wrote — a relation operand's own foreign key.
   *
   * The guard exists to stop a **caller** moving a row out of the scope that
   * selected it by naming a scoped column in `data`. A relation key is not
   * that: its value is the ORM's, the parent was reached through the parent
   * model's own scoping, and a child row this caller cannot see was already
   * refused before this runs. What is left is the operand doing what it means.
   *
   * Empty by default, and that direction matters: forgetting to pass it makes
   * the guard *stricter*, not looser, so an omission is a refused query rather
   * than a silent escape. That is the opposite of #79's defaulted `operation`,
   * where the default was the wrong answer — which is why this one is allowed
   * to have a default at all.
   */
  ormAuthored: readonly string[] = [],
): void {
  const data = args?.data;
  if (typeof data !== "object" || data === null) return;

  const escaping = unguarded.filter(
    (field) => field in data && !ormAuthored.includes(field),
  );
  if (escaping.length === 0) return;

  throw new ScopeEscapeError(context.model, context.operation, [
    ...new Set(escaping),
  ]);
}

/**
 * The columns a scope fragment constrains, as far as they can be known.
 *
 * Top-level keys only, and combinators excluded: `{ organizationId: 7 }` names
 * a column, `{ OR: [...] }` names a structure whose columns cannot be attributed
 * to this policy without interpreting the whole `where` grammar. Returning
 * nothing for those is the permissive answer and is the documented limit of the
 * guard rather than an oversight.
 */
function scopeOwnedFields(scope: unknown): string[] {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    return [];
  }

  const owned: string[] = [];
  for (const key of Object.keys(scope as Record<string, unknown>)) {
    if (key === "AND" || key === "OR" || key === "NOT") continue;
    owned.push(key);
  }
  return owned;
}

/**
 * Refuses a `create` whose policy scopes reads but says nothing about writes.
 *
 * The natural tenant policy carries both `scope` and `onCreate`, and for it this
 * is a no-op. The dangerous shape is `scope` alone: reads are confined to the
 * caller's tenant and an insert can name any tenant it likes, which is a policy
 * that looks complete and is half of one. Refused with the missing piece named.
 *
 * **Asks about one policy, not the chain.** It used to take the whole list and
 * pass if *any* member had an `onCreate`, which meant one policy could satisfy
 * the check on another's behalf — and `softDeletes()` ships a pass-through
 * `onCreate` precisely so that its own scope does not trip this. So adding soft
 * deletes to a model disarmed the guard for that model's tenant policy, and the
 * insert ran with the scoped column unset: the exact outcome the message below
 * describes, produced by the guard meant to prevent it. Composition is the
 * normal case now that `$policies` is a list, so the question has to be asked of
 * the policy that carries the scope.
 */
function assertCreateCovered(
  policy: ModelPolicy,
  context: PolicyContext,
): void {
  if (policy.onCreate) return;

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
      `scope.\n\n` +
      `Two ways out. Use update and create separately, which both scope ` +
      `normally — or leave the conflict key out of 'create', which Model.upsert ` +
      `runs as a scoped read and a scoped write inside one transaction. The ` +
      `refusal is about 'on conflict' specifically, not about upsert.`,
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


// --- nested policy application ---------------------------------------------

/**
 * Marks an `$exec` call as having had its policies applied by the caller.
 *
 * A module-private `Symbol`, deliberately, and **not exported from
 * `orm/index.ts`**. An application cannot forge it without importing something
 * that is not reachable, so it cannot become a way to skip policies — which is
 * the one thing iteration 6 spent three review rounds closing. `ExecOptions` is
 * public and a `policiesApplied?: boolean` there would have been exactly that
 * door.
 */
const PRE_SCOPED = Symbol("gemi.orm.policiesAppliedByCaller");

export function markPreScoped(options: object | undefined): object {
  return { ...options, [PRE_SCOPED]: true };
}

export function isPreScoped(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as Record<symbol, unknown>)[PRE_SCOPED] === true
  );
}

/**
 * Columns in this call's `data` that the **ORM** put there, not the caller.
 *
 * A nested relation operand writes exactly one column: the relation's own
 * foreign key, with a value this statement chose — the parent it is about, or
 * `null` for a `disconnect`. `assertNoScopeEscape` reads `args.data` and cannot
 * tell that apart from a caller naming the same column, so a child whose policy
 * scopes on its foreign key lost every relation operand that writes it (#98):
 *
 *     connect     ScopeEscapeError: Note.update writes 'folderId', which
 *                 Note's policy also scopes on…
 *     disconnect  ScopeEscapeError: Note.updateMany writes 'folderId', …
 *
 * The caller wrote `connect: { id: 1 }`. The error described a write they had
 * not made and sent them to their own `data`, where there was nothing to find.
 *
 * **A module-private `Symbol`, for the same reason `PRE_SCOPED` is one**: it is
 * not exported from `orm/index.ts`, so an application cannot forge it and it
 * cannot become a way to write a scoped column past the guard. An
 * `ExecOptions` field would have been exactly that door.
 */
const ORM_AUTHORED = Symbol("gemi.orm.columnsWrittenByTheOrm");

export function markOrmAuthored(
  options: object | undefined,
  fields: readonly string[],
): object {
  return { ...options, [ORM_AUTHORED]: fields };
}

export function ormAuthoredFields(options: unknown): readonly string[] {
  if (typeof options !== "object" || options === null) return EMPTY_FIELDS;
  const fields = (options as Record<symbol, unknown>)[ORM_AUTHORED];
  return Array.isArray(fields) ? (fields as string[]) : EMPTY_FIELDS;
}

const EMPTY_FIELDS: readonly string[] = [];

/**
 * The operation whose *return value* this `$exec` is producing, when that is not
 * the operation it runs.
 *
 * There is exactly one such call: the pre-read a read-first `delete` performs.
 * `delete({ where, include })` cannot be one statement — the children have to be
 * read before the row goes away — so `$exec` runs a `findFirst` inside a
 * transaction and hands **that** row to the caller, discarding what the `delete`
 * statement returned. Every other consequence of the split was already made
 * invisible: the read is scoped as the delete was, a miss raises
 * `RecordNotFoundError` naming `delete`, and #364 taught it to carry the `omit`.
 * `context.operation` was the last one left visible, and it was visible in the
 * worst direction — a `redact` keyed on `"delete"` stopped firing on the row the
 * caller got back, the moment an `include` was added (#366).
 *
 * **Redaction only, which is why it is named for redaction.** By the time this
 * is read the pre-read is already `markPreScoped`, so `applyPolicies` does not
 * run on it at all — no `before`, no `scope`, no `onCreate` / `onUpdate` sees
 * this value, and a scope written for reads cannot be turned off by it. The
 * remaining reader of the context is `applyRedaction`, over the one row that is
 * about to be returned.
 *
 * **Not the nested reads.** A relation read underneath is scoped and redacted as
 * `findMany` — see {@link NESTED_READ}, which is a constant for the reason this
 * is narrow: a nested read is a read of another model, whatever statement
 * encloses it. This marker travels no further than the row it names.
 *
 * A module-private `Symbol`, for the same reason `PRE_SCOPED` and `ORM_AUTHORED`
 * are: it is not exported from `orm/index.ts`, so an application cannot forge it
 * and cannot use it to make a query claim to be an operation it is not.
 */
const REDACTED_AS = Symbol("gemi.orm.operationTheRowIsReturnedFor");

export function markRedactedAs(
  options: object | undefined,
  operation: Operation,
): object {
  return { ...options, [REDACTED_AS]: operation };
}

export function redactedAs(options: unknown): Operation | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const operation = (options as Record<symbol, unknown>)[REDACTED_AS];
  return typeof operation === "string" ? (operation as Operation) : undefined;
}

/** Resolves a model name to its policies, so this file need not import the registry. */
export type PolicyLookup = (model: string) => {
  policies: readonly ModelPolicy[];
  schema: {
    name: string;
    // `kind` because a relation filter reads differently per kind — `some` /
    // `every` / `none` on a to-many, `is` / `isNot` on a to-one — and the walk
    // has to know which nested `where` it is scoping.
    relations: Record<string, { model: string; kind: "one" | "many" }>;
  };
} | undefined;

/**
 * The operation every node this walk touches is scoped as.
 *
 * `findMany` because that is what each of them *is* — one query for rows of
 * another model, named from inside somebody else's arguments — and because a
 * policy reading `context.operation` should see the read it is being asked
 * about rather than the statement that happens to enclose it. It is also in
 * `SCOPABLE`, which an inserting operation is not, and that mismatch is what
 * produced the bug this constant exists to prevent.
 *
 * **It is a constant rather than a parameter, and that is the fix.** The walk
 * used to take the root operation and pass it down; every node type then had
 * its own opportunity to be scoped as the enclosing statement instead of as
 * the read it is, and two of the four took it. Threading the right value
 * through four call sites leaves the wrong value expressible at all four. Not
 * accepting one at all is what makes it unrepresentable — the same reason #79
 * made `resolveLink`'s `operation` required rather than defaulted.
 */
const NESTED_READ: Operation = "findMany";

/**
 * Applies every *nested* model's policies to its own node in the argument tree,
 * recursively, returning a new tree.
 *
 * **Why this has to happen here rather than in the strategy.** A nested read under
 * the batched strategy acquires its policies by recursing through the child's own
 * `$exec`. A lateral join has no such call — the child's SQL is compiled inside
 * the parent's compile step — so the child's policies would never be consulted and
 * the subquery would be unscoped. That is a cross-tenant read arriving through a
 * new door, and iteration 9's plan doc has the full reasoning.
 *
 * The alternative was to let the strategy resolve policies while building the
 * subquery, which would give `compile/` knowledge of the registry and the ambient
 * user. It would then no longer be a pure function of the argument shape and the
 * plan cache would stop being sound — which invariant 2 and iteration 6's "do not
 * let policies see SQL" both exist to prevent.
 *
 * Doing it on the arg tree, before the plan key, keeps the compiler pure: it
 * receives a tree whose nested `where`s are already scoped, and the scope lands
 * inside whatever SQL the strategy chooses to emit. It also makes the README's
 * claim — that scoping applies under every strategy because policies rewrite the
 * arg tree before planning — *true*, where before it was true only of the
 * strategy that happened to recurse.
 *
 * **Every node it touches is a read.** There are four kinds — an `include` /
 * `select` node, a `_count` entry, a relation filter in a `where`, a relation
 * ordering in an `orderBy` — and each names *another model's rows*, whatever
 * the statement around it is doing. So each is scoped as {@link NESTED_READ}
 * rather than as the enclosing operation.
 *
 * Passing the root operation down broke two of the four, and only the ones
 * reachable from an insert were visible:
 *
 *   User.create({ data, include: { accounts: true } })
 *   User.create({ data, include: { _count: { select: { accounts: true } } } })
 *
 * - A child with a `scope` and no `onCreate` **raised**, with
 *   `Account has a policy that scopes reads but no 'onCreate'` — naming an
 *   operation the caller never asked for, about rows being read back rather
 *   than written. That is a legal policy: a model can scope reads and never
 *   create rows.
 * - A child with both took `applyPolicies`' inserting branch, which skips
 *   `withScope` and then runs `onCreate` over the node. It came out carrying
 *   `data: {}` where its `where` should have been, so the child's read scope —
 *   a tenant filter, or `softDeletes`' own `deletedAt: null` — silently
 *   disappeared from the nested read.
 *
 * The other two are not reachable from an insert, and the reason is worth
 * recording so the asymmetry is not rediscovered: `create` accepts only
 * `data` / `select` / `include` and `createMany` only `data`, so neither has a
 * `where` or an `orderBy` for a relation to be named in. They were still
 * wrong, just more quietly — under a root `update` a policy whose `scope`
 * reads `context.operation` saw `"update"` for what is a read, and answered
 * the question it was not asked.
 *
 * Nested *write* nodes under `data` are a different path entirely
 * (`planNestedWrites`), and already scope themselves as writes. This walk only
 * ever sees the read tree, which is why it can take the operation as a
 * constant at all.
 */

export function applyNestedPolicies(
  schema: {
    relations: Record<string, { model: string; kind: "one" | "many" }>;
  },
  args: any,
  user: unknown,
  system: boolean,
  lookup: PolicyLookup,
): any {
  if (args === undefined || args === null) return args;
  if (typeof args !== "object") return args;

  let out = args;

  for (const container of ["include", "select"] as const) {
    const tree = args[container];
    if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
      continue;
    }

    let rewritten: Record<string, unknown> | undefined;

    for (const key of Object.keys(tree)) {
      // `_count` counts another model's rows, so it is a read of that model and
      // carries its policies — the third shape of the same rule, after nested
      // includes and relation filters. An unscoped count is the quietest of the
      // three: it returns a *number*, so what leaks is how many rows exist in
      // tenants the caller cannot see.
      if (key === COUNT_KEY) {
        const scopedCounts = scopeCounts(
          schema,
          (tree as Record<string, unknown>)[key],
          user,
          system,
          lookup,
        );
        if (scopedCounts !== (tree as Record<string, unknown>)[key]) {
          rewritten ??= { ...(tree as Record<string, unknown>) };
          rewritten[key] = scopedCounts;
        }
        continue;
      }

      const relation = schema.relations[key];
      if (!relation) continue;

      const node = (tree as Record<string, unknown>)[key];
      if (node === undefined || node === false) continue;

      const target = lookup(relation.model);
      // An unregistered relation target is the relation planner's error to raise,
      // with the message it has for it — not this walk's.
      if (!target) continue;

      // `true` is shorthand for "this relation, no arguments", and it has to
      // *stay* `true` unless something actually applies. Turning it into `{}`
      // unconditionally changes the argument tree — and therefore the plan key —
      // for every include on an unpolicied model, which is a cache invalidation
      // and a canonical-shape change in exchange for nothing.
      const nodeArgs = node === true ? {} : node;
      if (typeof nodeArgs !== "object" || Array.isArray(nodeArgs)) continue;

      // Depth first, so a grandchild's scope is in place before its parent's
      // node is rewritten around it.
      const deeper = applyNestedPolicies(
        target.schema,
        nodeArgs,
        user,
        system,
        lookup,
      );

      // `system` short-circuits here as well as at the root: `asSystem` suspends
      // policies for the whole subtree, not just the model that was queried.
      const scoped =
        !system && target.policies.length > 0
          ? applyPolicies(
              target.policies,
              policyContext(target.schema.name, NESTED_READ, user, system),
              deeper,
            )
          : deeper;

      // Only when something changed. `deeper !== nodeArgs` covers a grandchild's
      // rewrite; `scoped !== deeper` covers this level's own scope.
      if (scoped !== nodeArgs) {
        rewritten ??= { ...(tree as Record<string, unknown>) };
        rewritten[key] = scoped;
      }
    }

    if (rewritten) out = { ...out, [container]: rewritten };
  }

  // Relation *orderings*. `orderBy: { organization: { name: "asc" } }` reads
  // another model's rows to sort by them, so the same rule applies — and this is
  // the one path where Prisma's grammar has no slot for the scope, so the walk
  // adds one. See `compile/order-relation.ts`.
  const ordered = scopeRelationOrderings(
    schema,
    out.orderBy,
    user,
    system,
    lookup,
  );
  if (ordered !== out.orderBy) out = { ...out, orderBy: ordered };

  // Relation *filters*, which reach another model's rows through `where` rather
  // than through `include`. Same rule, and it has to be the same walk: a filter
  // that reads a model is a read of that model.
  const filtered = scopeRelationFilters(
    schema,
    out.where,
    user,
    system,
    lookup,
  );
  if (filtered !== out.where) out = { ...out, where: filtered };

  return out;
}

/**
 * Adds a `where` to every relation ordering whose target carries policies.
 *
 * The other three paths all have somewhere for a scope to go: an `include` node
 * takes a `where`, a relation filter's operand *is* one, a `_count` entry takes
 * one. `orderBy: { rel: { field: "asc" } }` has none in Prisma's grammar, so this
 * writes the key the compiler reads.
 *
 * It has to happen. Ordering by a column of rows the caller cannot read leaks
 * their contents by comparison — sort ascending, sort descending, and the
 * invisible row's position tells you where its value falls. Ordering by
 * `_count` leaks the number outright.
 *
 * Unscoped rows then sort as `NULL`, because the correlated subquery finds
 * nothing. That is the same answer the caller would get if the row did not
 * exist, which is the whole point.
 */
function scopeRelationOrderings(
  schema: { relations: Record<string, { model: string; kind: "one" | "many" }> },
  orderBy: unknown,
  user: unknown,
  system: boolean,
  lookup: PolicyLookup,
): unknown {
  if (system) return orderBy;
  if (typeof orderBy !== "object" || orderBy === null) return orderBy;

  if (Array.isArray(orderBy)) {
    let changed = false;
    const out = orderBy.map((entry) => {
      const scoped = scopeRelationOrderings(
        schema,
        entry,
        user,
        system,
        lookup,
      );
      if (scoped !== entry) changed = true;
      return scoped;
    });
    return changed ? out : orderBy;
  }

  let rewritten: Record<string, unknown> | undefined;
  const source = orderBy as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const relation = schema.relations[key];
    if (!relation) continue;

    const node = source[key];
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      // Malformed, and the compiler reports it with the message it has.
      continue;
    }

    const target = lookup(relation.model);
    if (!target || target.policies.length === 0) continue;

    const scoped = applyPolicies(
      target.policies,
      policyContext(target.schema.name, NESTED_READ, user, system),
      node,
    );

    if (scoped !== node) {
      rewritten ??= { ...source };
      rewritten[key] = scoped;
    }
  }

  return rewritten ?? orderBy;
}

/**
 * Scopes each relation named inside `_count: { select: { … } }`.
 *
 * `true` becomes `{ where: <scope> }` for the same reason an `include: true`
 * does — a scope has to go somewhere — and stays `true` when nothing applies, so
 * an unpolicied count does not move the plan key.
 */
function scopeCounts(
  schema: { relations: Record<string, { model: string; kind: "one" | "many" }> },
  node: unknown,
  user: unknown,
  system: boolean,
  lookup: PolicyLookup,
): unknown {
  if (system) return node;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return node;
  }

  const selection = (node as Record<string, unknown>).select;
  if (
    typeof selection !== "object" ||
    selection === null ||
    Array.isArray(selection)
  ) {
    // Every other shape is the compiler's to report, with the message it has.
    return node;
  }

  let rewritten: Record<string, unknown> | undefined;
  const source = selection as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined || value === false) continue;

    const relation = schema.relations[key];
    if (!relation) continue;

    const target = lookup(relation.model);
    if (!target || target.policies.length === 0) continue;

    const nodeArgs = value === true ? {} : value;
    if (typeof nodeArgs !== "object" || Array.isArray(nodeArgs)) continue;

    const scoped = applyPolicies(
      target.policies,
      policyContext(target.schema.name, NESTED_READ, user, system),
      nodeArgs,
    );

    if (scoped !== nodeArgs) {
      rewritten ??= { ...source };
      rewritten[key] = scoped;
    }
  }

  return rewritten
    ? { ...(node as Record<string, unknown>), select: rewritten }
    : node;
}

/**
 * Scopes every relation filter inside a `where`, recursively.
 *
 * `where: { memberships: { some: {} } }` compiles to a correlated subquery over
 * `Membership`. Unscoped, it answers "does this user have a membership *in any
 * tenant*" — which returns no membership rows, so the leak is existence rather
 * than data, and correspondingly harder to notice. It is still a cross-tenant
 * read, and iteration 6's rule is that every read of a model carries that
 * model's policies.
 *
 * Structural sharing throughout: an unpolicied tree comes back as the same
 * object, so the plan key does not move for the queries this does not touch.
 */
function scopeRelationFilters(
  schema: { relations: Record<string, { model: string; kind: "one" | "many" }> },
  where: unknown,
  user: unknown,
  system: boolean,
  lookup: PolicyLookup,
): unknown {
  if (typeof where !== "object" || where === null) return where;

  if (Array.isArray(where)) {
    let changed = false;
    const out = where.map((entry) => {
      const scoped = scopeRelationFilters(
        schema,
        entry,
        user,
        system,
        lookup,
      );
      if (scoped !== entry) changed = true;
      return scoped;
    });
    return changed ? out : where;
  }

  let rewritten: Record<string, unknown> | undefined;
  const source = where as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;

    // Combinators hold more `where`s on the *same* model, so they recurse with
    // this schema rather than a child's.
    if (key === "AND" || key === "OR" || key === "NOT") {
      const scoped = scopeRelationFilters(
        schema,
        value,
        user,
        system,
        lookup,
      );
      if (scoped !== value) {
        rewritten ??= { ...source };
        rewritten[key] = scoped;
      }
      continue;
    }

    const relation = schema.relations[key];
    if (!relation) continue;

    const scoped = scopeRelationNode(
      relation,
      value,
      user,
      system,
      lookup,
    );
    if (scoped !== value) {
      rewritten ??= { ...source };
      rewritten[key] = scoped;
    }
  }

  return rewritten ?? where;
}

/** One relation filter: `{ some: … }`, `{ is: … }`, or a to-one shorthand. */
function scopeRelationNode(
  relation: { model: string; kind: "one" | "many" },
  value: unknown,
  user: unknown,
  system: boolean,
  lookup: PolicyLookup,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // `null` is `is: null` — "no related row at all". There is no nested `where`
    // to scope, and narrowing what counts as "related" here would change the
    // meaning of the filter rather than restrict it. The compiler reports every
    // other non-object.
    return value;
  }

  const target = lookup(relation.model);
  if (!target) return value;

  const operators = relationFilterOperators(relation.kind);
  const shorthand = !isOperatorForm(value, operators);
  const entries: Array<[string, unknown]> = shorthand
    ? [["is", value]]
    : Object.entries(value as Record<string, unknown>);

  let rewritten: Record<string, unknown> | undefined;

  for (const [operator, argument] of entries) {
    if (argument === null || argument === undefined) continue;

    // Depth first: a filter nested inside this one is scoped before this level
    // wraps anything around it.
    const deeper = scopeRelationFilters(
      target.schema,
      argument,
      user,
      system,
      lookup,
    );

    const scope =
      !system && target.policies.length > 0
        ? applyPolicies(
            target.policies,
            policyContext(target.schema.name, NESTED_READ, user, system),
            { where: deeper },
          ).where
        : deeper;

    const final = operator === "every" ? invertForEvery(deeper, scope) : scope;

    if (final !== argument) {
      rewritten ??= shorthand
        ? {}
        : { ...(value as Record<string, unknown>) };
      rewritten[operator] = final;
    }
  }

  if (!rewritten) return value;
  // A scoped shorthand becomes the explicit form, because there is nowhere else
  // to put the operator once the argument is no longer the whole object.
  return rewritten;
}

/**
 * `every` needs the scope **outside** the negation, and this is the one place
 * where ANDing a scope into a nested `where` would be wrong.
 *
 * `every: X` compiles to `not exists (child where correlated and not X)`. AND a
 * scope S into X and you get `not exists (… and not (X and S))`, which is
 * "every child either matches X or is invisible" — a parent with one hidden
 * non-matching child now *passes*, and worse, a parent whose only children are
 * invisible passes too. The scope has to restrict which children are considered,
 * not which ones count as matching:
 *
 *     not exists (child where correlated and S and not X)
 *
 * In argument space that is `every: { OR: [{ NOT: S }, X] }` — because
 * `not (not S or X)` is `S and not X`. Expressed as arguments rather than as SQL
 * so the compiler stays a pure function of the shape and the plan cache stays
 * sound; it is the same move iteration 9 made when it put nested policies on the
 * arg tree instead of teaching the lateral strategy about the registry.
 *
 * **This logic is outside the differential harness's reach, deliberately, and
 * therefore rests on its own tests.** Those 147 cases compare gemi against
 * Prisma, and Prisma has no policies — so nothing in them exercises a scoped
 * path at all. Do not read the matrix being green as coverage of this rewrite.
 * What stands over it is the unit tests on `applyNestedPolicies` and the
 * database test in `templates/saas-starter/app/models/relation-filter-policies.test.ts`,
 * which is arranged so the two candidate rewrites give *different* answers.
 *
 * The failure this guards against is not a crash or an obviously wrong row
 * count. It is a filter that silently consults rows the caller cannot see, and
 * the tempting "simplification" to `AND` is exactly how it comes back.
 */
function invertForEvery(inner: unknown, scoped: unknown): unknown {
  if (scoped === inner) return inner;

  // `applyPolicies` adds its fragments as `AND` members beside the caller's own
  // keys, so what it added is exactly the tail of `AND` that was not there
  // before.
  const before = andMembers(inner);
  const after = andMembers(scoped);
  const added = after.slice(before.length);
  if (added.length === 0) return inner;

  const restriction =
    added.length === 1 ? added[0] : { AND: added };

  return { OR: [{ NOT: restriction }, inner] };
}

function andMembers(where: unknown): unknown[] {
  if (typeof where !== "object" || where === null) return [];
  const value = (where as Record<string, unknown>).AND;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
