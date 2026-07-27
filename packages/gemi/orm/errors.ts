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
