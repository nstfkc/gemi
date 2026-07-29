/**
 * Thrown when the compiler is handed an argument it does not implement yet.
 *
 * Every public operation accepts the full Prisma argument type from iteration 1
 * — signatures are final, capability grows underneath them. The price of that is
 * that anything unimplemented has to fail loudly: silently dropping a `take: 10`
 * and returning the whole table is the worst failure mode this ORM has.
 */
export class UnsupportedQueryError extends Error {
  constructor(
    public readonly argument: string,
    public readonly model: string,
    public readonly operation: string,
    /**
     * What cannot work, and what to do instead.
     *
     * **Required**, which is the second half of #61 — the first being the
     * `UnsupportedByDesignError` split beside this. It was optional, and the
     * refusals that omitted it were the highest-traffic ones: an argument the
     * operation does not accept, on the path a typo takes. Those said only
     * *that* something was refused, to the reader least likely to know why.
     *
     * Required rather than conventionally-supplied for the reason five other
     * parameters here are — `render`'s `origin`, `changedFields`' `schema`,
     * `RelationExecutor.exec`'s `preScoped`, `resolveLink`'s `operation`,
     * `assertPageArgument`'s reported name: where omitting an argument produces
     * a *worse* result rather than an error, `tsc` is the only thing that keeps
     * a convention. Ninety-five of a hundred call sites already passed one; the
     * five that did not are exactly the ones nobody revisited.
     *
     * `UnknownFieldError` and `UnknownRelationError` set the standard this
     * meets: both enumerate the valid names rather than only rejecting the
     * invalid one.
     */
    detail: string,
  ) {
    super(
      `gemi ORM does not support '${argument}' yet (${model}.${operation}). ` +
        detail,
    );
    this.name = "UnsupportedQueryError";
  }
}

/**
 * An argument the ORM has **decided not to implement**, as opposed to one it has
 * not implemented yet.
 *
 * The distinction is the whole point, and it is a distinction a caller can act
 * on: "yet" means wait for a release, "will not" means change the code. Sharing
 * one error for both meant `docs/orm.md` could list `omit` under *Not in scope*
 * while the runtime said "yet" — a contradiction a reader has no way to
 * resolve, and the one #68 exists to end.
 *
 * A subclass rather than a sibling, so `catch (e) { if (e instanceof
 * UnsupportedQueryError) … }` keeps working for callers that do not care which
 * kind it is.
 */
/**
 * An argument the ORM **does** implement, given a value it cannot mean.
 *
 * The third category, and the one that made "yet" wrong four separate times —
 * #82, #88, #100 and #101 each corrected it at their own call site before #61
 * was found to own the problem. The taxonomy the three classes now draw:
 *
 *   not implemented yet     UnsupportedQueryError      wait for a release
 *   decided against         UnsupportedByDesignError   change the call  (#78)
 *   implemented, bad value  InvalidArgumentError       fix the value
 *
 * `take: "-2"` is the clearest case. `take` is implemented; `"-2"` is not a
 * take. Telling that caller the ORM "does not support 'take' yet" is wrong on
 * both halves — it does, and there is nothing to wait for — and it sends them
 * to a changelog when the fix is one character in their own code.
 *
 * **Extends `UnsupportedQueryError`**, so every existing `catch` and every test
 * asserting the base class keeps working. That is the same choice
 * `UnsupportedByDesignError` made, and it is what lets a taxonomy be added to a
 * shipped ORM without a breaking change: the specific classes are for the
 * reader, the base class is for the handler.
 *
 * **Where the taxonomy stops, and why it stops there.** An argument that is not
 * in the grammar at all keeps the base class and its "yet" — `{ nope: 1 }`
 * reports "does not support 'nope' yet". That is right for half of what reaches
 * that path and wrong for the other half: the same check refuses a typo and a
 * real Prisma argument this ORM has genuinely not implemented, and nothing at
 * that point can tell them apart. Splitting it would mean carrying Prisma's
 * full argument grammar per operation, which is a large amount of duplicated
 * schema for a small gain.
 *
 * What makes it tolerable is the sentence after it. Since #61's other half made
 * `detail` mandatory, that refusal always continues *"findMany takes include,
 * omit, orderBy, select, skip, take, where"* — so a caller who typed `nope`
 * learns it is not coming from the very next clause, without the class having
 * to know. Recorded here rather than left to be re-derived, because "the third
 * class did not cover this one" is the obvious first reading and it is not the
 * interesting part.
 */
export class InvalidArgumentError extends UnsupportedQueryError {
  constructor(
    argument: string,
    model: string,
    operation: string,
    /** What is wrong with the value, and what a good one looks like. */
    reason: string,
  ) {
    super(argument, model, operation, reason);
    this.name = "InvalidArgumentError";
    this.message = `Invalid '${argument}' (${model}.${operation}). ${reason}`;
  }
}

export class UnsupportedByDesignError extends UnsupportedQueryError {
  constructor(
    argument: string,
    model: string,
    operation: string,
    /** What to use instead. Required — see #61: a refusal owes the caller a next step. */
    reason: string,
  ) {
    super(argument, model, operation, reason);
    this.name = "UnsupportedByDesignError";
    this.message =
      `gemi ORM does not implement '${argument}' (${model}.${operation}), ` +
      `and this is a decision rather than a gap. ${reason}`;
  }
}

/**
 * Thrown when an argument names something that is not a field on the model. A
 * `where` key with no matching field is an error, never a passthrough — that is
 * the rule that keeps user input out of the identifier positions in the SQL.
 */
export class UnknownFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly model: string,
    known: string[],
  ) {
    super(
      `'${field}' is not a field on model ${model}. ` +
        `Known fields: ${known.join(", ")}.`,
    );
    this.name = "UnknownFieldError";
  }
}

/**
 * Thrown when a column holds something the generated schema says it cannot —
 * an unparseable timestamp, a fractional value in a `BigInt` column, malformed
 * JSON. Every dialect needs it, which is why it lives here rather than beside
 * one of them.
 *
 * It exists so those cases fail rather than decode into a plausible wrong
 * value: `new Date("nonsense")` is an `Invalid Date`, not an error, and it
 * would travel a long way before anyone noticed.
 */
export class DecodeError extends Error {
  constructor(
    public readonly field: { column: string; type: string },
    public readonly value: unknown,
  ) {
    super(
      `Could not decode the value ${JSON.stringify(String(value))} from column ` +
        `'${field.column}' as ${field.type}. The column's contents do not match ` +
        `the Prisma schema — was it written by something other than Prisma or ` +
        `the gemi ORM?`,
    );
    this.name = "DecodeError";
  }
}

/**
 * Thrown by the `*OrThrow` operations when the query matched nothing. Prisma
 * raises `NotFoundError` / `P2025` for the same case; the differential harness
 * compares the fact of throwing, not the error type.
 */
export class RecordNotFoundError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
  ) {
    super(`No ${model} found (${model}.${operation}).`);
    this.name = "RecordNotFoundError";
  }
}

/**
 * Thrown when a write violates a unique constraint.
 *
 * DECISION — gemi defines its own error rather than mirroring Prisma's codes.
 *
 * Prisma raises `PrismaClientKnownRequestError` with code `P2002` and
 * `meta.target` holding the field names. Mirroring that would ease a migration
 * for code already branching on `P2002` — but nothing in this repository does
 * (checked), and carrying a `P` code implies the rest of the taxonomy is
 * implemented too: `P2003`, `P2025`, and the fifty others an application might
 * reasonably then expect to catch. Claiming a compatibility surface we have not
 * built is worse than asking the few call sites that need it to catch a gemi
 * error instead.
 *
 * What the contract does promise is the part that matters: the error is typed,
 * catchable, and names the fields — as *field* names, the way Prisma's
 * `meta.target` does, not as the database columns the driver reported.
 */
export class UniqueConstraintError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
    /** Field names, mapped back through the schema from the driver's columns. */
    public readonly fields: string[],
    /** The constraint's own name, when the dialect reports one. */
    public readonly constraint?: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Unique constraint violated on ${model}.${operation}` +
        (fields.length > 0 ? ` for ${fields.join(", ")}` : "") +
        (constraint ? ` (constraint '${constraint}')` : "") +
        `. A ${model} with those values already exists.`,
      options,
    );
    this.name = "UniqueConstraintError";
  }
}

/**
 * Thrown when a write needs `RETURNING` and the dialect has none.
 *
 * Unreachable on SQLite and Postgres, which both support it. It exists so that
 * the MySQL / MariaDB path is a named gap rather than a wrong answer: the
 * fallback there is `lastInsertRowid` plus a re-select, which is a different
 * statement shape and is not implemented.
 */
export class ReturningUnsupportedError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
    public readonly dialect: string,
  ) {
    super(
      `${model}.${operation} needs RETURNING to report its result, and the ` +
        `'${dialect}' dialect does not support it. The fallback — ` +
        `lastInsertRowid plus a re-select — is not implemented.`,
    );
    this.name = "ReturningUnsupportedError";
  }
}

/**
 * Thrown when a policy denies an operation.
 *
 * Two ways to get here, and the message distinguishes them because the fixes
 * are different: a policy's `before` returned false, or the model is policied
 * and there is no user in scope at all.
 *
 * The second is the deny-by-default rule, and it is the reason this error is
 * loud. A cron tick or a queue worker reading a policied model has no user, and
 * the alternative — treating "no user" as "no policy" — means the dangerous
 * case is the silent one: a request whose auth middleware was misconfigured
 * would read every tenant's rows rather than failing. So unscoped access is
 * always a decision written at the call site, through `Model.asSystem`.
 */
export class PolicyDeniedError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
    public readonly reason: "denied" | "no-user" = "denied",
  ) {
    super(
      reason === "no-user"
        ? `${model}.${operation} is governed by a policy and there is no user ` +
            `in scope. If this is a cron tick, a queue worker or a script, say ` +
            `so at the call site: Model.asSystem(() => ...). Policies are ` +
            `never skipped just because a user failed to turn up.`
        : `${model}.${operation} was denied by ${model}'s policy.`,
    );
    this.name = "PolicyDeniedError";
  }
}

/**
 * Thrown when an `update` writes to a column its own policy's `scope` selects on,
 * and the policy has no `onUpdate` saying what that should mean.
 *
 * The shape it catches:
 *
 *     scope: (ctx) => ({ organizationId: ctx.user.organizationId })
 *     // ...and then
 *     User.update({ where: { id }, data: { organizationId: 999 } })
 *
 * The scope did its job — only rows in the caller's own tenant could be selected
 * — and the statement still hands one of them to another tenant. Afterwards the
 * row is outside the scope, so it cannot be read back and cannot be put right by
 * the same caller: a one-way door rather than a visible failure. The usual way in
 * is not malice but mass assignment, a handler forwarding request fields into
 * `data`.
 *
 * This is `assertCreateCovered`'s question asked of the other write. There it is
 * "you scoped reads but never said what an insert means"; here it is "you scoped
 * reads but never said whether an update may move a row out". Both are answered
 * by writing the hook, including when the answer is "allow it" —
 * `onUpdate: (_ctx, data) => data` is a complete and legitimate answer, and
 * saying it out loud is the point.
 *
 * **What it cannot see.** The scope-owned columns are read off the top level of
 * the fragment the policy returned, so `{ organizationId: 7 }` is understood and
 * `{ OR: [...] }` is not — a scope built from combinators is not attributed to
 * any column and an update through it is not checked. Narrowing that would mean
 * either interpreting arbitrary `where` grammar or refusing every update on such
 * a model, and neither is worth it: the guard is a rail on the common shape, not
 * a proof.
 */
export class ScopeEscapeError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
    public readonly fields: readonly string[],
  ) {
    const named = fields.map((field) => `'${field}'`).join(", ");
    super(
      `${model}.${operation} writes ${named}, which ${model}'s policy also ` +
        `scopes on — so this update can move a row outside the scope that ` +
        `selected it, where the caller can no longer read or repair it.\n\n` +
        `Add an onUpdate to that policy. It may reassert the column ` +
        `(data => ({ ...data, ${fields[0]}: ctx.user.${fields[0]} })), reject ` +
        `the write, or allow it explicitly with (_ctx, data) => data — all ` +
        `three are fine, and the point is that the policy says which.`,
    );
    this.name = "ScopeEscapeError";
  }
}

/**
 * Thrown when a model class carries policies but is not the class the registry
 * resolves its name to.
 *
 * This exists because of a cross-tenant leak that shipped past review. The
 * generated `index.ts` registers the *generated* base — `register("Account",
 * AccountModel)` — while an application authors its policy on a subclass:
 *
 *     export class Account extends AccountModel {
 *       static $policies = [{ scope: (ctx) => ({ organizationId: … }) }]
 *     }
 *
 * A root query goes through `Account`, so `policiesFor(this)` finds the policy
 * and the scope applies. A **nested** relation read resolves through the
 * registry, gets `AccountModel`, and walks a prototype chain the policy is not
 * on — so `User.findMany({ include: { accounts: true } })` returned every
 * tenant's accounts. Root queries scoped, nested reads unscoped: exactly the
 * Prisma behaviour policies exist to fix, and silent.
 *
 * Raised at the first query through the unregistered class, naming the one-line
 * fix, because the alternative is data crossing a tenant boundary with nothing
 * to notice it.
 *
 * It fires on a divergence in the resolved policy *chain*, not merely on the two
 * classes differing. A plain subclass that adds no policy of its own inherits
 * the same policy objects in the same order, so a nested read resolving to its
 * parent applies exactly what the root query applied — no divergence, nothing
 * to refuse. An earlier version compared class identity and rejected
 * `class AdminUser extends User {}` for policies it had not written.
 */
export class UnregisteredPolicyClassError extends Error {
  constructor(
    public readonly model: string,
    public readonly registered: string,
    public readonly queried: string,
    /**
     * Which side carries the policies that would be skipped. The two directions
     * need different advice: one is a missing registration, the other is a
     * query through the wrong class.
     */
    public readonly carries: "queried" | "registered" = "queried",
  ) {
    super(
      carries === "queried"
        ? `${queried} carries policies but the registry resolves '${model}' to ` +
            `${registered}. Nested relation reads go through the registry, so ` +
            `they would run on ${registered} and skip every policy on ` +
            `${queried} — scoped at the root, unscoped inside an include. ` +
            `Register the class that carries the policy:\n\n` +
            `    import { register } from "gemi/orm"\n` +
            `    export class ${queried} extends ${registered} { … }\n` +
            `    register("${model}", ${queried})\n`
        : `This query goes through ${queried}, but the registry resolves ` +
            `'${model}' to ${registered}, which carries policies ${queried} ` +
            `does not. Nested relation reads would be scoped and this query is ` +
            `not — the same policy applying to some queries and not others. ` +
            `Query ${registered} instead:\n\n` +
            `    ${registered}.findMany(…)\n\n` +
            `If skipping policies is intended, say so at the call site — that ` +
            `is what Model.asSystem() is for, and it is the only way to do it ` +
            `that a reader can see.\n`,
    );
    this.name = "UnregisteredPolicyClassError";
  }
}

/**
 * Thrown when a statement would bind more parameters than the driver's wire
 * protocol can carry.
 *
 * Three shapes reach it, all of them scaling with the caller's *data* rather
 * than with the query's shape: `createMany` at `rows × columns`, an `in` list on
 * SQLite (one placeholder per element, and such a list is routinely
 * request-derived), and a to-many `include` on SQLite, which batches an `in`
 * over the parent keys. Both limits are hard and low enough to hit with an
 * ordinary import — Postgres counts parameters in an int16 (65535), SQLite
 * defaults `SQLITE_MAX_VARIABLE_NUMBER` to 32766. Postgres escapes the last two
 * either way: `= any($1)` is one parameter however long the array.
 *
 * Prisma chunks the insert automatically. Doing that here means several
 * statements, which without a transaction is a partially-applied `createMany`
 * on failure — so it waits for iteration 5, and until then this is a named gap
 * rather than a driver error naming neither the model nor the cause. Same
 * treatment as `ReturningUnsupportedError`, for the same reason.
 */
export class ParameterLimitError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
    public readonly required: number,
    public readonly limit: number,
    public readonly dialect: string,
    detail: string,
  ) {
    super(
      `${model}.${operation} would bind ${required} parameters, and the ` +
        `'${dialect}' driver accepts at most ${limit} in one statement. ` +
        `${detail}` +
        (operation === "createMany"
          ? ` A createMany over the ceiling is normally split across statements ` +
            `inside one transaction, so reaching this means splitting cannot ` +
            `help: a single row binds more than the driver accepts.`
          : ` Splitting is not something this operation can do for you — one ` +
            `statement has to carry one answer. Narrow the query.`),
    );
    this.name = "ParameterLimitError";
  }
}

/**
 * Thrown when a write omits a column that has no value to fall back on: not
 * supplied, no client-side default, no database default, and not nullable.
 *
 * Raised in the compiler rather than left to the database so the message names
 * the field and the model, instead of surfacing as `NOT NULL constraint failed`
 * with a column name and no context.
 */
export class MissingRequiredValueError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
    public readonly field: string,
  ) {
    super(
      `${model}.${operation} is missing a value for '${field}', which is ` +
        `required and has no default.`,
    );
    this.name = "MissingRequiredValueError";
  }
}

/**
 * Thrown when an `include` — or a relation-shaped key inside a `select` — names
 * something the model does not declare as a relation.
 */
export class UnknownRelationError extends Error {
  constructor(
    public readonly relation: string,
    public readonly model: string,
    known: string[],
  ) {
    super(
      `'${relation}' is not a relation on model ${model}. ` +
        (known.length > 0
          ? `Known relations: ${known.join(", ")}.`
          : `${model} declares no relations.`),
    );
    this.name = "UnknownRelationError";
  }
}

/**
 * Thrown when an include tree nests deeper than the guard allows.
 *
 * A cyclic include is legal and finite — `user -> accounts -> user` terminates
 * because the caller wrote a finite tree. What this catches is an *unbounded*
 * one: an argument tree built by a loop, or forwarded from a request body, that
 * describes a thousand levels. Under the batched planner every level is at least
 * one query, so the guard is what stops a malformed argument from becoming a
 * self-inflicted denial of service.
 */
export class RelationDepthExceededError extends Error {
  constructor(
    public readonly model: string,
    public readonly limit: number,
  ) {
    super(
      `The include tree nests more than ${limit} relations deep (at model ` +
        `${model}). Deeply nested includes are legal, so this is a guard ` +
        `against a generated or malformed argument tree rather than a limit on ` +
        `modelling — every level costs at least one query.`,
    );
    this.name = "RelationDepthExceededError";
  }
}

/**
 * Thrown when a relation names a model the registry does not hold. Every
 * relation in a generated artifact was emitted from a model in the same
 * `schema.prisma`, so this can only mean the artifact and the registry disagree.
 */
export class UnregisteredRelationTargetError extends Error {
  constructor(
    public readonly model: string,
    public readonly relation: string,
    public readonly target: string,
    known: string[],
  ) {
    super(
      `${model}.${relation} points at model '${target}', which nothing has ` +
        `registered. The generated artifact and the registry disagree: re-run ` +
        `\`prisma generate\`, and check that app/models/generated/index.ts is ` +
        `imported. ` +
        (known.length > 0
          ? `Registered models: ${known.join(", ")}.`
          : `Nothing is registered at all.`),
    );
    this.name = "UnregisteredRelationTargetError";
  }
}

/**
 * Thrown when a relation is registered on both sides but the two sides do not
 * describe a link the planner can follow: no matching `relationName` on the
 * other model, or a `from` / `to` naming a field that is not there. Like
 * `UnregisteredRelationTargetError`, it means a stale generated artifact — a
 * consistent one cannot produce it.
 */
export class MalformedRelationError extends Error {
  constructor(
    public readonly model: string,
    public readonly relation: string,
    detail: string,
  ) {
    super(
      `Cannot resolve how ${model}.${relation} joins: ${detail} This means ` +
        `app/models/generated is stale or hand-edited — re-run ` +
        `\`prisma generate\`.`,
    );
    this.name = "MalformedRelationError";
  }
}

/** Thrown when a relation resolves to a model name nothing registered. */
export class ModelNotRegisteredError extends Error {
  constructor(name: string, known: string[]) {
    super(
      `No model is registered under the name '${name}'. ` +
        (known.length > 0
          ? `Registered models: ${known.join(", ")}.`
          : `Nothing is registered — is app/models/generated/index.ts imported?`),
    );
    this.name = "ModelNotRegisteredError";
  }
}

/** Thrown when a model class is used before the generator has given it a schema. */
export class MissingModelSchemaError extends Error {
  constructor(className: string) {
    super(
      `${className} has no $schema. Model subclasses must extend a generated ` +
        `base class from app/models/generated/models.ts.`,
    );
    this.name = "MissingModelSchemaError";
  }
}
