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
