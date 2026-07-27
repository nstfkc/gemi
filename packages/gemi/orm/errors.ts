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
    detail?: string,
  ) {
    super(
      `gemi ORM does not support '${argument}' yet (${model}.${operation}).` +
        (detail ? ` ${detail}` : ""),
    );
    this.name = "UnsupportedQueryError";
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
        `${detail} Automatic chunking is not implemented: it would make this ` +
        `several statements, which cannot be made atomic until transactions ` +
        `land. Split the call.`,
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
