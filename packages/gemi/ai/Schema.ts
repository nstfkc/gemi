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
declare const OPTIONAL: unique symbol;

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

/**
 * A schema whose key may be left out of the object containing it.
 *
 * Marked with a property rather than detected from the output type, because
 * `undefined extends T` — the obvious test — is true of *everything* when
 * `strictNullChecks` is off, which is how this package and plenty of apps
 * compile. That version made every field of every tool optional, and did it
 * quietly: the JSON Schema was still right, so only the TypeScript types lied.
 */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly [OPTIONAL]: true;
}

export type AnySchema = Schema<any>;

export type Infer<S> = S extends Schema<infer T> ? T : never;

/**
 * Collapses a type into one flat object.
 *
 * `ShapeOutput` builds its result as an intersection of two mapped types, one
 * required and one optional, and that intersection is what every hover, every
 * error message and every type assertion would otherwise show. The difference
 * is between an app reading `{ command: string; cwd?: string }` and reading two
 * mapped types joined by an ampersand.
 *
 * It also drops `readonly`, which the mapped types copy from the shape literal
 * — `s.object({ ... })` infers that literal as `const` to keep the keys, and a
 * tool has no reason to receive an immutable input because of how its schema
 * was written down.
 */
type Flatten<T> = { -readonly [K in keyof T]: T[K] };

type ShapeOutput<S extends Record<string, AnySchema>> = Flatten<
  {
    [K in keyof S as S[K] extends OptionalSchema<any> ? never : K]: Infer<S[K]>;
  } & {
    [K in keyof S as S[K] extends OptionalSchema<any> ? K : never]?: Infer<S[K]>;
  }
>;

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
  optional(): OptionalSchemaBuilder<T>;
  nullable(): SchemaBuilder<T | null>;
}

interface OptionalSchemaBuilder<T> extends SchemaBuilder<T | undefined>, OptionalSchema<T> {}

// --- the runtime ---------------------------------------------------------

/**
 * What a builder actually is. `optional` and `nullable` are flags rather than
 * wrapper nodes so that `.nullable().optional()` cannot nest into something
 * whose emitted shape depends on which order they were called in.
 */
type Definition = {
  node: SchemaNode;
  description?: string;
  optional: boolean;
  nullable: boolean;
};

type SchemaNode =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "object"; shape: Record<string, Definition> }
  | { kind: "array"; item: Definition }
  | { kind: "union"; members: readonly Definition[] };

type ParseResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** The public interface with the phantoms and the generic taken off. */
interface RuntimeSchema {
  toJSONSchema(): JSONSchema;
  parse(value: unknown): unknown;
  safeParse(value: unknown): ParseResult;
  describe(description: string): RuntimeSchema;
  optional(): RuntimeSchema;
  nullable(): RuntimeSchema;
}

/**
 * Definitions hang off the builders here rather than on the builders
 * themselves: a property, however obscurely named, is a property an app can
 * see, serialise or accidentally depend on, and `Schema<T>` promises exactly
 * three methods.
 */
const definitions = new WeakMap<object, Definition>();

function definitionOf(schema: AnySchema): Definition {
  const definition = definitions.get(schema);
  if (!definition) {
    throw new Error("gemi/ai: expected a schema built with `s`, got a foreign object");
  }
  return definition;
}

// --- emitting ------------------------------------------------------------

function emit(definition: Definition): JSONSchema {
  const body = allowNull(emitNode(definition.node), definition.optional || definition.nullable);
  return definition.description ? { description: definition.description, ...body } : body;
}

function emitNode(node: SchemaNode): JSONSchema {
  switch (node.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    // `const` rather than a one-member `enum`, because a boolean literal has no
    // `enum` form and one branch that works for all three beats two that
    // disagree about what a literal is.
    case "literal":
      return { type: typeof node.value, const: node.value };
    case "enum":
      return { type: "string", enum: node.values };
    case "array":
      return { type: "array", items: emit(node.item) };
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(node.shape).map(([key, child]) => [key, emit(child)]),
        ),
        // Every declared property, optional ones included. This is the whole of
        // strict mode's bargain: the model is never allowed to omit a key, so
        // "may be absent" has to be spelled as "may be null" instead.
        required: Object.keys(node.shape),
        additionalProperties: false,
      };
    case "union":
      return { anyOf: node.members.map(emit) };
  }
}

/**
 * Widens a schema to admit `null` — for a `nullable()` field, and for the null
 * an `optional()` field tells the model to send in place of omitting the key.
 */
function allowNull(base: JSONSchema, on: boolean): JSONSchema {
  if (!on) return base;
  // A union is already a list of alternatives; appending to it is flatter than
  // nesting an `anyOf` inside an `anyOf`, and reads the same to the model.
  if (base.anyOf) return { ...base, anyOf: [...base.anyOf, { type: "null" }] };
  // `enum` and `const` cannot carry the null themselves — `enum` here is
  // strings and numbers by declaration — so those get wrapped rather than
  // widened.
  if (base.enum || base.const !== undefined) return { anyOf: [base, { type: "null" }] };
  if (typeof base.type === "string") return { ...base, type: [base.type, "null"] };
  return { anyOf: [base, { type: "null" }] };
}

// --- parsing -------------------------------------------------------------

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * What the value looked like. For a literal or an enum the *type* is usually
 * right and the value is wrong, and "expected \"refund\", got string" tells
 * whoever is reading the failed tool call nothing they did not know.
 */
function saw(node: SchemaNode, value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (node.kind === "literal" || node.kind === "enum") {
    const primitive =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    if (primitive) return JSON.stringify(value);
  }
  return typeName(value);
}

function wanted(definition: Definition): string {
  const node = definition.node;
  const base = (() => {
    switch (node.kind) {
      case "string":
      case "number":
      case "boolean":
        return node.kind;
      case "literal":
        return JSON.stringify(node.value);
      case "enum":
        return `one of ${node.values.map((v) => JSON.stringify(v)).join(" | ")}`;
      case "array":
        return "array";
      case "object":
        return "object";
      case "union":
        return "one of the variants";
    }
  })();
  return definition.optional || definition.nullable ? `${base} or null` : base;
}

/** `orders[2].total: ` — empty at the root, where a prefix would be noise. */
function at(path: string): string {
  return path ? `${path}: ` : "";
}

/**
 * How well a value matches, used only to pick which union variant to blame.
 * A literal or an enum hit counts for far more than an ordinary field, because
 * that is what a discriminated union turns on: the variant whose `kind` matched
 * is the one the model meant, whatever else it got wrong.
 */
function score(definition: Definition, value: unknown): number {
  if (value === null || value === undefined) {
    return definition.optional || definition.nullable ? 1 : 0;
  }
  const node = definition.node;
  switch (node.kind) {
    case "string":
      return typeof value === "string" ? 1 : 0;
    case "number":
      return typeof value === "number" ? 1 : 0;
    case "boolean":
      return typeof value === "boolean" ? 1 : 0;
    case "literal":
      return value === node.value ? 10 : 0;
    case "enum":
      return typeof value === "string" && node.values.includes(value) ? 10 : 0;
    case "array":
      return Array.isArray(value) ? 1 : 0;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return 0;
      const source = value as Record<string, unknown>;
      let total = 1;
      for (const [key, child] of Object.entries(node.shape)) {
        total += score(child, source[key]);
      }
      return total;
    }
    case "union":
      return node.members.reduce((best, member) => Math.max(best, score(member, value)), 0);
  }
}

/** `drop` is a key that should not appear in the parsed object at all. */
type Reading = { drop: boolean; value: unknown };

function read(definition: Definition, value: unknown, path: string, errors: string[]): Reading {
  // `optional` is checked before `nullable`, so a schema that is both treats
  // null as "absent". They are not distinguishable on the wire: strict mode
  // gives the model one spelling for "nothing", and pretending otherwise would
  // mean `.nullable().optional()` silently kept a key the type says is
  // optional. What that trades away is the ability to say "present and null" on
  // a field that may also be absent — a distinction no model can express here.
  if (definition.optional && (value === null || value === undefined)) {
    return { drop: true, value: undefined };
  }
  if (definition.nullable && value === null) return { drop: false, value: null };
  return { drop: false, value: readNode(definition, value, path, errors) };
}

function readNode(definition: Definition, value: unknown, path: string, errors: string[]): unknown {
  const node = definition.node;
  const fail = () => {
    errors.push(`${at(path)}expected ${wanted(definition)}, got ${saw(node, value)}`);
    return undefined;
  };

  switch (node.kind) {
    case "string":
      return typeof value === "string" ? value : fail();
    case "number":
      // NaN and Infinity do not survive `JSON.stringify`, so a tool that
      // returns one produces a body the provider cannot be sent.
      return typeof value === "number" && Number.isFinite(value) ? value : fail();
    case "boolean":
      return typeof value === "boolean" ? value : fail();
    case "literal":
      return value === node.value ? value : fail();
    case "enum":
      return typeof value === "string" && node.values.includes(value) ? value : fail();
    case "array": {
      if (!Array.isArray(value)) return fail();
      return value.map((item, index) => {
        const element = read(node.item, item, `${path}[${index}]`, errors);
        return element.drop ? undefined : element.value;
      });
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
      const source = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.shape)) {
        const element = read(child, source[key], path ? `${path}.${key}` : key, errors);
        if (!element.drop) output[key] = element.value;
      }
      // Unknown keys are DROPPED, not rejected. `additionalProperties: false`
      // has already told the model not to send them, so one arriving anyway is
      // a slip rather than an attack, and failing a whole tool call over a
      // stray field costs a turn to fix nothing. Dropping is also what keeps
      // `execute` from ever seeing a field its input type says cannot be there.
      return output;
    }
    case "union": {
      let best: { errors: string[]; score: number } | undefined;
      for (const member of node.members) {
        const attempt: string[] = [];
        const element = read(member, value, path, attempt);
        if (attempt.length === 0) return element.drop ? undefined : element.value;
        const points = score(member, value);
        if (!best || points > best.score) best = { errors: attempt, score: points };
      }
      // "no match" is useless when one field of a five-field variant was wrong.
      // Naming the closest variant and why it stopped is the difference between
      // a debuggable bad tool call and a shrug.
      errors.push(`${at(path)}no matching variant; closest: ${best.errors.join("; ")}`);
      return undefined;
    }
  }
}

/**
 * The one cast in this file, and the reason it has to exist: `OUTPUT` and
 * `OPTIONAL` are `declare const` unique symbols. They have no runtime
 * counterpart — they are inference channels — so no object that can actually be
 * constructed satisfies `Schema<T>` structurally. Funnelling every builder
 * through here means the lie is told once, in one place, and everything else in
 * the module is checked against the real declarations.
 */
function make<T>(definition: Definition): SchemaBuilder<T> {
  return build(definition) as unknown as SchemaBuilder<T>;
}

/**
 * Builders are immutable: `describe`, `optional` and `nullable` each build a
 * fresh one from a copied definition. Mutating in place is the obvious
 * implementation and it is wrong — `const id = s.string()` reused in two
 * objects, described in one of them, would carry that description into the
 * other, and the only symptom is a model being told the wrong thing about a
 * field somewhere else.
 */
function build(definition: Definition): RuntimeSchema {
  const runtime: RuntimeSchema = {
    toJSONSchema: () => emit(definition),
    parse(value) {
      const errors: string[] = [];
      const result = read(definition, value, "", errors);
      if (errors.length > 0) throw new Error(errors.join("; "));
      return result.drop ? undefined : result.value;
    },
    safeParse(value) {
      const errors: string[] = [];
      const result = read(definition, value, "", errors);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, value: result.drop ? undefined : result.value };
    },
    describe: (description) => build({ ...definition, description }),
    optional: () => build({ ...definition, optional: true }),
    // Clearing `optional` is not tidiness. `nullable()` returns a
    // `SchemaBuilder`, not an `OptionalSchemaBuilder`, so the key it describes
    // is required again in `ShapeOutput` — and a parse that still dropped it
    // would hand back an object missing a key its own type declares.
    nullable: () => build({ ...definition, nullable: true, optional: false }),
  };
  definitions.set(runtime, definition);
  return runtime;
}

function leaf(node: SchemaNode): Definition {
  return { node, optional: false, nullable: false };
}

export const s: {
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
} = {
  string: () => make<string>(leaf({ kind: "string" })),
  number: () => make<number>(leaf({ kind: "number" })),
  boolean: () => make<boolean>(leaf({ kind: "boolean" })),
  literal: (value) => make<typeof value>(leaf({ kind: "literal", value })),
  enum: (values) => make<(typeof values)[number]>(leaf({ kind: "enum", values })),
  object: (shape) =>
    make<ShapeOutput<typeof shape>>(
      leaf({
        kind: "object",
        shape: Object.fromEntries(
          Object.entries(shape).map(([key, child]) => [key, definitionOf(child)]),
        ),
      }),
    ),
  array: (item) => make<Infer<typeof item>[]>(leaf({ kind: "array", item: definitionOf(item) })),
  // A union is legal wherever a property is, but not as the root of a
  // structured output: the provider wants an object there. That is the
  // provider's check to make, not this one's.
  union: (members) =>
    make<Infer<(typeof members)[number]>>(
      leaf({ kind: "union", members: members.map(definitionOf) }),
    ),
};
