// @ts-nocheck — the ai rfc is a sketch, not an interface anyone depends on:
// nothing exports `gemi/ai` and nothing in the package imports it, so its only
// reader is `tsc`, and a half-drawn signature there fails `bun run typecheck`
// and `build:types` for everyone.

/**
 * The schema layer for tool inputs, tool outputs and structured final answers.
 *
 * Two things have to come out of one declaration: a TypeScript type, so
 * `execute(input)` is typed at the call site and the result is typed in the
 * browser, and a JSON Schema, because that is what the model is actually shown.
 * A phantom `Schema<T>` gives the first and nothing of the second, and a
 * hand-written JSON Schema next to a hand-written type gives both and lets them
 * drift. So the builder below is the single source, and `Infer` reads the type
 * back off it.
 *
 * Everything here is deliberately narrower than JSON Schema. OpenAI's strict
 * structured output only accepts a subset — every property listed in
 * `required`, `additionalProperties: false` on every object, no patterns, no
 * `oneOf` at the root — and a builder that cannot express the rejected parts is
 * better than one that lets you write a schema the API refuses at runtime.
 */

export type JSONSchema = {
  type?: string | string[];
  description?: string;
  enum?: readonly (string | number)[];
  const?: string | number | boolean;
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: JSONSchema;
  anyOf?: readonly JSONSchema[];
};

declare const OUTPUT: unique symbol;

/**
 * `T` is carried in a phantom property rather than a real one: it exists only
 * for inference, and a real field would show up on the object the app writes.
 */
export interface Schema<T> {
  readonly [OUTPUT]: T;
  /** The JSON Schema handed to the provider. */
  toJSONSchema(): JSONSchema;
  /**
   * Parses a value coming back from the model. Tool arguments arrive as a JSON
   * string the model generated, so they are untrusted in exactly the way a
   * request body is: shape-checked before `execute` ever sees them.
   */
  parse(value: unknown): T;
  safeParse(value: unknown): { ok: true; value: T } | { ok: false; errors: string[] };
}

export type AnySchema = Schema<any>;

export type Infer<S> = S extends Schema<infer T> ? T : never;

type ShapeOutput<S extends Record<string, AnySchema>> = {
  // `-?` and the optionality below are computed from `.optional()` having wrapped
  // the member type in `| undefined`, so the TS shape matches what the model may
  // legally omit — see the note on `optional()` about strict mode.
  [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]>;
} & {
  [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]>;
};

interface SchemaBuilder<T> extends Schema<T> {
  /**
   * The description is not documentation — it is the only prose the model gets
   * about a field, and it is the difference between a tool that is called
   * correctly and one that is not.
   */
  describe(description: string): this;
  /**
   * Strict mode has no notion of an omitted key: every property must appear in
   * `required`. So `optional()` emits a nullable union and the model is told to
   * send `null`, while the TypeScript type says `| undefined` and the parsed
   * value drops the key. The asymmetry is the point — it is what lets an app
   * write ordinary optional fields against an API that forbids them.
   */
  optional(): SchemaBuilder<T | undefined>;
  nullable(): SchemaBuilder<T | null>;
}

export declare const s: {
  string(): SchemaBuilder<string>;
  number(): SchemaBuilder<number>;
  boolean(): SchemaBuilder<boolean>;
  literal<const L extends string | number | boolean>(value: L): SchemaBuilder<L>;
  /** Modelled as a JSON Schema `enum`, which strict mode does support. */
  enum<const L extends readonly [string, ...string[]]>(values: L): SchemaBuilder<L[number]>;
  object<const S extends Record<string, AnySchema>>(shape: S): SchemaBuilder<ShapeOutput<S>>;
  array<const S extends AnySchema>(item: S): SchemaBuilder<Infer<S>[]>;
  /**
   * `anyOf` of object schemas, discriminated by a literal member. Left in
   * because tool outputs are frequently a success/failure pair, and modelling
   * that as one object with everything optional is worse for the model.
   */
  union<const S extends readonly [AnySchema, AnySchema, ...AnySchema[]]>(
    members: S,
  ): SchemaBuilder<Infer<S[number]>>;
};
