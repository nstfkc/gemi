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
 *
 * `json()` is the one deliberate hole in that, for the formats strict mode
 * cannot describe at all: a record with arbitrary keys, a mixed-type tuple, a
 * recursive document. It does not widen the subset — it turns strict mode off
 * for the schema containing it, which `supportsStrict` reads back off the tree
 * so that no caller has to remember to.
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

/**
 * Any value JSON can carry. The default output type of `json()`, and the
 * annotation an app reaches for when it hands one of those values on.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  /**
   * `safeParse` with the failures as structured issues rather than sentences:
   * each one names the path it is about, a JSON Schema keyword as its `code`
   * and the keyword's argument in `params`. For an app that validates a value
   * against a schema itself — a form, a stored record — and wants to word or
   * group the problems per field. All failures are reported, not the first.
   */
  validate(value: unknown): { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };
}

/**
 * One reason a value failed `validate`.
 *
 * `code` is the JSON Schema keyword the value broke — the same names Ajv puts
 * on its `keyword` — so a mapping written against one reads the other:
 *
 * - `required`: the key is missing (`path` ends in it).
 * - `type`: the wrong kind of value, an integer that isn't whole, or a value
 *   that isn't JSON at all.
 * - `const`, `enum`: a literal or a choice that didn't match (`params.allowedValues`).
 * - `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`,
 *   `exclusiveMaximum`, `minItems`, `maxItems`: `params.limit` is the bound.
 * - `format`: `params.format` names the format the string failed.
 * - `anyOf`: no union member matched; `message` names the closest one's problems.
 *
 * `message` is the sentence `safeParse` reports for it, without the path.
 */
export type SchemaIssueCode =
  | "required"
  | "type"
  | "const"
  | "enum"
  | "anyOf"
  | "minLength"
  | "maxLength"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "minItems"
  | "maxItems"
  | "format";

export type SchemaIssue = {
  /** Keys and array indices from the root, `[]` for the root itself. */
  path: (string | number)[];
  code: SchemaIssueCode;
  message: string;
  params: Record<string, unknown>;
};

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

/**
 * The constraints `s.fromJSONSchema` can carry over from a JSON Schema. None of
 * the builders set them; they exist so that a schema read from data validates
 * what it says it does.
 *
 * They are CHECKED, NOT EMITTED as keywords. Strict structured output refuses
 * most of them (`minLength`, `maxLength`, `minimum` on Anthropic; any `format`
 * outside a short list on both), so the model is told them in the field's
 * description instead, and `parse` enforces them — a model that ignores the
 * prose gets an `invalid_tool_input` it can correct, the same as a wrong type.
 */
type StringChecks = {
  minLength?: number;
  maxLength?: number;
  format?: { name: string; test: (value: string) => boolean };
};

type NumberChecks = {
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
};

type ArrayChecks = { minItems?: number; maxItems?: number };

type SchemaNode =
  | { kind: "string"; checks?: StringChecks }
  | { kind: "number"; checks?: NumberChecks }
  | { kind: "boolean" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: readonly string[]; checks?: StringChecks }
  | { kind: "object"; shape: Record<string, Definition> }
  | { kind: "array"; item: Definition; checks?: ArrayChecks }
  | { kind: "union"; members: readonly Definition[] }
  /** Constrains nothing. The node strict mode has no spelling for. */
  | { kind: "json" };

type ParseResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

type Path = (string | number)[];

/** The public interface with the phantoms and the generic taken off. */
interface RuntimeSchema {
  toJSONSchema(): JSONSchema;
  parse(value: unknown): unknown;
  safeParse(value: unknown): ParseResult;
  validate(value: unknown): { ok: true; value: unknown } | { ok: false; issues: SchemaIssue[] };
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

/**
 * Whether `value` is a schema built with `s`. How `HttpRequest` tells an `s`
 * body schema from a map of rules (#711), without a property on the builder.
 */
export function isSchema(value: unknown): value is SchemaBuilder<unknown> {
  return typeof value === "object" && value !== null && definitions.has(value);
}

function definitionOf(schema: AnySchema): Definition {
  const definition = definitions.get(schema);
  if (!definition) {
    throw new Error("gemi/ai: expected a schema built with `s`, got a foreign object");
  }
  return definition;
}

// --- emitting ------------------------------------------------------------

function emit(definition: Definition): JSONSchema {
  // A `json` node already admits every value there is, null included, so
  // widening it would only add an `anyOf` for the model to read past — and one
  // whose second branch is a strictly narrower repeat of its first.
  const widen = (definition.optional || definition.nullable) && definition.node.kind !== "json";
  const body = allowNull(emitNode(definition.node), widen);
  const description = [definition.description, hint(definition.node)].filter(Boolean).join(" ");
  return description ? { description, ...body } : body;
}

/**
 * The checks a node carries, in words, for the description — the one place a
 * strict-mode provider lets them through. See `StringChecks`.
 */
function hint(node: SchemaNode): string {
  const said: string[] = [];
  if (node.kind === "string" || node.kind === "enum") {
    const checks = node.checks;
    if (checks?.format) said.push(`Format: ${checks.format.name}.`);
    if (checks?.minLength !== undefined) said.push(`At least ${checks.minLength} characters.`);
    if (checks?.maxLength !== undefined) said.push(`At most ${checks.maxLength} characters.`);
  } else if (node.kind === "number") {
    const checks = node.checks;
    if (checks?.minimum !== undefined) said.push(`Minimum ${checks.minimum}.`);
    if (checks?.exclusiveMinimum !== undefined) {
      said.push(`Greater than ${checks.exclusiveMinimum}.`);
    }
    if (checks?.maximum !== undefined) said.push(`Maximum ${checks.maximum}.`);
    if (checks?.exclusiveMaximum !== undefined) said.push(`Less than ${checks.exclusiveMaximum}.`);
  } else if (node.kind === "array") {
    const checks = node.checks;
    if (checks?.minItems !== undefined) said.push(`At least ${checks.minItems} items.`);
    if (checks?.maxItems !== undefined) said.push(`At most ${checks.maxItems} items.`);
  }
  return said.join(" ");
}

function emitNode(node: SchemaNode): JSONSchema {
  switch (node.kind) {
    case "string":
      return { type: "string" };
    case "number":
      // `integer` is in the strict subset of every provider gemi speaks to.
      return { type: node.checks?.integer ? "integer" : "number" };
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
    // The empty schema, which is JSON Schema's own way of saying "any value" —
    // no `type` listing all seven, which reads as a constraint the model then
    // has to check itself. What the field actually is gets said in
    // `description`, the one channel a model reads either way.
    case "json":
      return {};
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
      case "number":
        return node.checks?.integer ? "integer" : "number";
      case "string":
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
      case "json":
        return "a JSON value";
    }
  })();
  return definition.optional || definition.nullable ? `${base} or null` : base;
}

/** `orders[2].total` — keys joined with dots, indices in brackets. */
function formatPath(path: Path): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : out ? `.${segment}` : segment;
  }
  return out;
}

/** `orders[2].total: ` — empty at the root, where a prefix would be noise. */
function at(path: Path): string {
  const text = formatPath(path);
  return text ? `${text}: ` : "";
}

/** The sentence `safeParse` reports for an issue. */
function render(issue: SchemaIssue): string {
  return `${at(issue.path)}${issue.message}`;
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
    // Matches, because it matches everything — but at the score of a plain
    // scalar, so a sibling variant that pinned its discriminant still wins the
    // blame.
    //
    // Reached only when no member parsed, which for a `json` member means the
    // value is not JSON at all: a function, a bigint, a cycle. Then this is
    // what makes the report name the reason the value was refused rather than
    // the discriminant of a variant the model was never aiming at.
    case "json":
      return 1;
  }
}

/** `drop` is a key that should not appear in the parsed object at all. */
type Reading = { drop: boolean; value: unknown };

function read(definition: Definition, value: unknown, path: Path, issues: SchemaIssue[]): Reading {
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
  return { drop: false, value: readNode(definition, value, path, issues) };
}

function readNode(
  definition: Definition,
  value: unknown,
  path: Path,
  issues: SchemaIssue[],
): unknown {
  const node = definition.node;
  const fail = () => {
    const code: SchemaIssueCode =
      value === undefined
        ? "required"
        : node.kind === "literal"
          ? "const"
          : node.kind === "enum" && typeof value === "string"
            ? "enum"
            : "type";
    const params =
      code === "const"
        ? { allowedValue: (node as { value: unknown }).value }
        : code === "enum"
          ? { allowedValues: (node as { values: readonly string[] }).values }
          : {};
    issues.push({
      path,
      code,
      message: `expected ${wanted(definition)}, got ${saw(node, value)}`,
      params,
    });
    return undefined;
  };

  switch (node.kind) {
    case "string":
      if (typeof value !== "string") return fail();
      checkString(node.checks, value, path, issues);
      return value;
    case "number":
      // NaN and Infinity do not survive `JSON.stringify`, so a tool that
      // returns one produces a body the provider cannot be sent.
      if (typeof value !== "number" || !Number.isFinite(value)) return fail();
      if (node.checks?.integer && !Number.isInteger(value)) return fail();
      checkNumber(node.checks, value, path, issues);
      return value;
    case "boolean":
      return typeof value === "boolean" ? value : fail();
    case "literal":
      return value === node.value ? value : fail();
    case "enum":
      if (typeof value !== "string" || !node.values.includes(value)) return fail();
      checkString(node.checks, value, path, issues);
      return value;
    case "array": {
      if (!Array.isArray(value)) return fail();
      const items = value.map((item, index) => {
        const element = read(node.item, item, [...path, index], issues);
        return element.drop ? undefined : element.value;
      });
      const { minItems, maxItems } = node.checks ?? {};
      if (minItems !== undefined && value.length < minItems) {
        issues.push({
          path,
          code: "minItems",
          message: `expected at least ${minItems} items, got ${value.length}`,
          params: { limit: minItems },
        });
      }
      if (maxItems !== undefined && value.length > maxItems) {
        issues.push({
          path,
          code: "maxItems",
          message: `expected at most ${maxItems} items, got ${value.length}`,
          params: { limit: maxItems },
        });
      }
      return items;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
      const source = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.shape)) {
        const element = read(child, source[key], [...path, key], issues);
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
      let best: { issues: SchemaIssue[]; score: number } | undefined;
      for (const member of node.members) {
        const attempt: SchemaIssue[] = [];
        const element = read(member, value, path, attempt);
        if (attempt.length === 0) return element.drop ? undefined : element.value;
        const points = score(member, value);
        if (!best || points > best.score) best = { issues: attempt, score: points };
      }
      // "no match" is useless when one field of a five-field variant was wrong.
      // Naming the closest variant and why it stopped is the difference between
      // a debuggable bad tool call and a shrug.
      issues.push({
        path,
        code: "anyOf",
        message: `no matching variant; closest: ${best!.issues.map(render).join("; ")}`,
        params: { closest: best!.issues },
      });
      return undefined;
    }
    // Passed through by reference, not rebuilt. Two reasons beyond the obvious
    // one: a rebuild would turn a `Date` into `{}` by copying own properties
    // that a `toJSON` was going to replace anyway, and the agent loop signs the
    // *parsed* input and later verifies the signature against it — a parse that
    // is exactly the identity cannot disagree with itself.
    case "json":
      if (value === undefined) return fail();
      checkJson(value, path, issues, new Set());
      return value;
  }
}

/**
 * Length in code points, not UTF-16 units — what JSON Schema (and Ajv) count,
 * so an emoji is one character against a `maxLength` either way.
 */
function length(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

function checkString(
  checks: StringChecks | undefined,
  value: string,
  path: Path,
  issues: SchemaIssue[],
): void {
  if (!checks) return;
  const { minLength, maxLength, format } = checks;
  if (minLength !== undefined || maxLength !== undefined) {
    const size = length(value);
    if (minLength !== undefined && size < minLength) {
      issues.push({
        path,
        code: "minLength",
        message: `expected at least ${minLength} characters, got ${size}`,
        params: { limit: minLength },
      });
    }
    if (maxLength !== undefined && size > maxLength) {
      issues.push({
        path,
        code: "maxLength",
        message: `expected at most ${maxLength} characters, got ${size}`,
        params: { limit: maxLength },
      });
    }
  }
  if (format) {
    let ok = false;
    try {
      ok = format.test(value) === true;
    } catch {
      // A check that throws has not said yes.
    }
    if (!ok) {
      issues.push({
        path,
        code: "format",
        message: `expected a string in format "${format.name}"`,
        params: { format: format.name },
      });
    }
  }
}

function checkNumber(
  checks: NumberChecks | undefined,
  value: number,
  path: Path,
  issues: SchemaIssue[],
): void {
  if (!checks) return;
  const bound = (
    code: SchemaIssueCode,
    limit: number | undefined,
    passes: (limit: number) => boolean,
    words: string,
  ) => {
    if (limit === undefined || passes(limit)) return;
    issues.push({
      path,
      code,
      message: `expected ${words} ${limit}, got ${value}`,
      params: { limit },
    });
  };
  bound("minimum", checks.minimum, (limit) => value >= limit, "at least");
  bound("exclusiveMinimum", checks.exclusiveMinimum, (limit) => value > limit, "more than");
  bound("maximum", checks.maximum, (limit) => value <= limit, "at most");
  bound("exclusiveMaximum", checks.exclusiveMaximum, (limit) => value < limit, "less than");
}

/**
 * Checks that a value is JSON, which is the only check a `json()` node makes.
 *
 * Tool arguments arrive through `JSON.parse`, so this never fires on model
 * input. It fires on a tool *output* or a structured answer an app built, where
 * a `bigint` or a cycle throws inside `JSON.stringify` and a function or a
 * `symbol` is dropped without a word — one turn later, with the provider's
 * request body to debug instead of the value.
 *
 * `undefined` and non-plain objects are deliberately allowed below the root:
 * `JSON.stringify` drops an `undefined` property, writes `null` for an
 * `undefined` element, and calls `toJSON` where there is one. Those are JSON's
 * own answers, and rejecting a `Date` to catch a `Map` is a bad trade.
 *
 * `toJSON` is honoured rather than assumed harmless: the walk checks what it
 * returns and never the object behind it, because that is all `JSON.stringify`
 * will look at.
 */
function checkJson(
  value: unknown,
  path: Path,
  issues: SchemaIssue[],
  seen: Set<object>,
  // False for the value a `toJSON` just returned: `JSON.stringify` applies
  // `toJSON` once per position, and re-applying it is how a pair of them
  // returning each other became an infinite loop.
  applyToJSON = true,
): void {
  const reject = (what: string) => {
    issues.push({ path, code: "type", message: `expected a JSON value, got ${what}`, params: {} });
  };

  switch (typeof value) {
    case "undefined":
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) reject(String(value));
      return;
    case "bigint":
      return reject("a bigint");
    case "function":
      return reject("a function");
    case "symbol":
      return reject("a symbol");
  }

  if (value === null) return;
  const object = value as object;

  // The cycle guard comes FIRST, above `toJSON`, and that ordering is the whole
  // of it: a `toJSON` is arbitrary code that can hand back another object with a
  // `toJSON` of its own, so two of them returning each other is a cycle that
  // `seen` catches and an identity test cannot. Below the guard, that pair hung
  // `safeParse` forever — and a `toJSON` returning a fresh object each time threw
  // `RangeError` out of a function documented to return `{ ok: false, errors }`.
  if (seen.has(object)) return reject("a circular reference");
  seen.add(object);
  try {
    // `JSON.stringify` asks `toJSON` what to write and never looks at the object
    // itself, so that answer is what has to be checked. Without this the walk
    // descended into the wrapper's own fields and refused values `stringify`
    // serializes without complaint — a `toJSON` returning a string off a `bigint`
    // field being the archetype, since writing a `toJSON` is exactly what one
    // does about a field JSON cannot carry. `Date` passed only by having no own
    // enumerable properties to trip over.
    const toJSON = applyToJSON ? (object as { toJSON?: unknown }).toJSON : undefined;
    if (typeof toJSON === "function") {
      let replaced: unknown;
      try {
        replaced = (toJSON as (key?: string) => unknown).call(object);
      } catch {
        return reject("a toJSON that threw");
      }
      // `JSON.stringify` applies `toJSON` once per value position, not until it
      // stops changing, so the replacement is checked with it switched off here
      // — its nested values get their own.
      if (replaced === undefined) return reject("a toJSON that returns undefined");
      return checkJson(replaced, path, issues, seen, false);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => checkJson(item, [...path, index], issues, seen));
    } else {
      for (const [key, child] of Object.entries(object)) {
        checkJson(child, [...path, key], issues, seen);
      }
    }
  } finally {
    // Removed rather than left in: `seen` is the path currently being walked, and
    // keeping it would call the same object appearing twice side by side — which
    // `JSON.stringify` writes out twice quite happily — a cycle. In a `finally`
    // so the `toJSON` returns above cannot leave it marked.
    seen.delete(object);
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
      const issues: SchemaIssue[] = [];
      const result = read(definition, value, [], issues);
      if (issues.length > 0) throw new Error(issues.map(render).join("; "));
      return result.drop ? undefined : result.value;
    },
    safeParse(value) {
      const issues: SchemaIssue[] = [];
      const result = read(definition, value, [], issues);
      if (issues.length > 0) return { ok: false, errors: issues.map(render) };
      return { ok: true, value: result.drop ? undefined : result.value };
    },
    validate(value) {
      const issues: SchemaIssue[] = [];
      const result = read(definition, value, [], issues);
      if (issues.length > 0) return { ok: false, issues };
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

// --- reading a JSON Schema ---------------------------------------------------

/**
 * How `s.fromJSONSchema` checks a `format`. `true` accepts any string (a format
 * that is only a hint, like `markdown`); a `RegExp` or a function decides.
 */
export type JSONSchemaFormat = true | RegExp | ((value: string) => boolean);

export type FromJSONSchemaOptions = {
  /**
   * The formats the schema may name. A `format` not listed here is refused, not
   * ignored: gemi ships no format checks of its own, and a format that quietly
   * checked nothing would be a constraint that only looks enforced.
   */
  formats?: Record<string, JSONSchemaFormat>;
  /**
   * Keywords to skip as annotations, on top of the ones always skipped:
   * `title`, `$schema`, `$id`, `$comment`, `examples`, `default`,
   * `deprecated`, `readOnly`, `writeOnly`, and every `x-` keyword.
   */
  ignoreKeywords?: readonly string[];
};

/**
 * Thrown by `s.fromJSONSchema` for a schema outside the subset `s` models.
 * `problems` lists every one found, each starting with the path into the
 * schema (`properties.price.type: ...`), so a schema written by a user or a
 * model can be sent back with all of them at once.
 */
export class JSONSchemaError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `gemi/ai: s.fromJSONSchema cannot model this schema:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
    this.name = "JSONSchemaError";
    this.problems = problems;
  }
}

const ANNOTATIONS = new Set([
  "title",
  "$schema",
  "$id",
  "$comment",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** The keywords each type may carry, beyond `type`, `description`, `enum` and `const`. */
const KEYWORDS: Record<string, readonly string[]> = {
  string: ["minLength", "maxLength", "format"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
  boolean: [],
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a JSON Schema into a definition, collecting every problem rather than
 * stopping at the first. Returns `undefined` where a node could not be read;
 * the caller throws once the walk is done.
 */
function fromJSON(
  schema: unknown,
  options: FromJSONSchemaOptions,
  where: string,
  problems: string[],
): Definition | undefined {
  const problem = (message: string, at = where) => {
    problems.push(at ? `${at}: ${message}` : message);
    return undefined;
  };
  const child = (key: string) => (where ? `${where}.${key}` : key);
  if (!isPlainObject(schema)) return problem("expected a schema object");

  const ignored = new Set(options.ignoreKeywords ?? []);
  const skip = (key: string) => ANNOTATIONS.has(key) || key.startsWith("x-") || ignored.has(key);

  // `type: [T, "null"]`, `enum` with a null in it and an `anyOf` with a
  // `{ type: "null" }` member all mean the same: T, nullable.
  let nullable = false;
  let type = schema.type;
  if (Array.isArray(type)) {
    const rest = type.filter((t) => t !== "null");
    if (rest.length !== 1) {
      return problem(
        `type ${JSON.stringify(type)} is not supported; only one type, optionally with "null". Use anyOf for alternatives`,
        child("type"),
      );
    }
    nullable = rest.length < type.length;
    type = rest[0];
  }
  if (type !== undefined && (typeof type !== "string" || !(type in KEYWORDS))) {
    return problem(
      `type ${JSON.stringify(type)} is not supported; expected one of ${Object.keys(KEYWORDS).join(", ")}`,
      child("type"),
    );
  }

  const allowed = new Set([
    "type",
    "description",
    "enum",
    "const",
    "anyOf",
    ...(type ? KEYWORDS[type as string] : []),
  ]);
  let unknown = false;
  for (const key of Object.keys(schema)) {
    if (allowed.has(key) || skip(key)) continue;
    unknown = true;
    const owner = Object.entries(KEYWORDS).find(([, keys]) => keys.includes(key));
    problem(
      owner && owner[0] !== type
        ? `"${key}" applies to type ${owner[0]}, and this schema is ${type ? `type ${type}` : "untyped"}`
        : `"${key}" is not supported by s.fromJSONSchema`,
      child(key),
    );
  }
  if (unknown) return undefined;

  if (schema.description !== undefined && typeof schema.description !== "string") {
    return problem("expected a string", child("description"));
  }
  const description = schema.description as string | undefined;
  const finish = (node: SchemaNode): Definition => ({
    node,
    optional: false,
    nullable,
    ...(description ? { description } : {}),
  });

  if (schema.anyOf !== undefined) {
    if (type !== undefined || schema.enum !== undefined || schema.const !== undefined) {
      return problem("anyOf cannot be combined with type, enum or const here", child("anyOf"));
    }
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      return problem("expected a non-empty array", child("anyOf"));
    }
    const members: Definition[] = [];
    let failed = false;
    schema.anyOf.forEach((member, index) => {
      if (isPlainObject(member) && member.type === "null" && Object.keys(member).length === 1) {
        nullable = true;
        return;
      }
      const read = fromJSON(member, options, child(`anyOf[${index}]`), problems);
      if (read) members.push(read);
      else failed = true;
    });
    if (failed) return undefined;
    if (members.length === 0) return problem("anyOf has only null in it", child("anyOf"));
    if (members.length === 1) {
      const only = members[0]!;
      return {
        ...only,
        nullable: only.nullable || nullable,
        ...(description ? { description } : {}),
      };
    }
    return finish({ kind: "union", members });
  }

  if (schema.const !== undefined) {
    const value = schema.const;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return problem("only a string, number or boolean const is supported", child("const"));
    }
    if (type !== undefined && typeof value !== (type === "integer" ? "number" : type)) {
      return problem(`const ${JSON.stringify(value)} is not of type ${type}`, child("const"));
    }
    return finish({ kind: "literal", value });
  }

  let stringChecks: StringChecks | undefined;
  if (type === "string") {
    stringChecks = readStringChecks(schema, options, child, problems);
    if (stringChecks === null) return undefined;
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      return problem("expected a non-empty array", child("enum"));
    }
    const values = schema.enum.filter((value) => value !== null);
    if (values.length < schema.enum.length) nullable = true;
    const bad = values.find(
      (value) =>
        !(typeof value === "string" || typeof value === "number" || typeof value === "boolean") ||
        (type !== undefined && typeof value !== (type === "integer" ? "number" : type)),
    );
    if (bad !== undefined || values.length === 0) {
      return problem(
        type
          ? `every value must be of type ${type}${values.length === 0 ? ", and there must be one" : `; ${JSON.stringify(bad)} is not`}`
          : "only strings, numbers and booleans are supported",
        child("enum"),
      );
    }
    if (values.every((value) => typeof value === "string")) {
      return finish({
        kind: "enum",
        values: [...new Set(values as string[])],
        ...(stringChecks ? { checks: stringChecks } : {}),
      });
    }
    const literals = [...new Set(values as (string | number | boolean)[])];
    if (literals.length === 1) return finish({ kind: "literal", value: literals[0]! });
    return finish({
      kind: "union",
      members: literals.map((value) => leaf({ kind: "literal", value })),
    });
  }

  switch (type) {
    case undefined:
      return problem("a schema needs a type, an enum, a const or an anyOf");
    case "string":
      return finish({ kind: "string", ...(stringChecks ? { checks: stringChecks } : {}) });
    case "number":
    case "integer": {
      const checks: NumberChecks = type === "integer" ? { integer: true } : {};
      let failed = false;
      for (const key of KEYWORDS.number!) {
        const value = schema[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          problem("expected a number", child(key));
          failed = true;
          continue;
        }
        checks[key as "minimum"] = value;
      }
      if (failed) return undefined;
      return finish({ kind: "number", ...(Object.keys(checks).length > 0 ? { checks } : {}) });
    }
    case "boolean":
      return finish({ kind: "boolean" });
    case "array": {
      if (!isPlainObject(schema.items)) {
        return problem(
          'an array needs "items" to be one schema (tuples are not supported)',
          child("items"),
        );
      }
      const checks: ArrayChecks = {};
      let failed = false;
      for (const key of ["minItems", "maxItems"] as const) {
        const value = schema[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          problem("expected a non-negative integer", child(key));
          failed = true;
          continue;
        }
        checks[key] = value;
      }
      const item = fromJSON(schema.items, options, child("items"), problems);
      if (!item || failed) return undefined;
      return finish({ kind: "array", item, ...(Object.keys(checks).length > 0 ? { checks } : {}) });
    }
    case "object": {
      const properties = schema.properties ?? {};
      if (!isPlainObject(properties)) return problem("expected an object", child("properties"));
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
        return problem(
          "only false is supported; a record with arbitrary keys has no strict-mode form (use s.json())",
          child("additionalProperties"),
        );
      }
      const required = schema.required ?? [];
      if (!Array.isArray(required) || !required.every((key) => typeof key === "string")) {
        return problem("expected an array of property names", child("required"));
      }
      const missing = required.filter((key) => !Object.hasOwn(properties, key));
      if (missing.length > 0) {
        return problem(
          `lists properties the schema doesn't have: ${missing.join(", ")}`,
          child("required"),
        );
      }
      const shape: Record<string, Definition> = {};
      let failed = false;
      for (const [key, value] of Object.entries(properties)) {
        const read = fromJSON(value, options, child(`properties.${key}`), problems);
        if (!read) {
          failed = true;
          continue;
        }
        // Not in `required` is "may be left out", which is `optional()`: the
        // model is told to send null, and a parse drops the key.
        shape[key] = required.includes(key) ? read : { ...read, optional: true };
      }
      if (failed) return undefined;
      return finish({ kind: "object", shape });
    }
  }
  return undefined;
}

/** `null` when a problem was reported. */
function readStringChecks(
  schema: Record<string, unknown>,
  options: FromJSONSchemaOptions,
  child: (key: string) => string,
  problems: string[],
): StringChecks | undefined | null {
  const checks: StringChecks = {};
  let failed = false;
  for (const key of ["minLength", "maxLength"] as const) {
    const value = schema[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problems.push(`${child(key)}: expected a non-negative integer`);
      failed = true;
      continue;
    }
    checks[key] = value;
  }
  if (schema.format !== undefined) {
    const name = schema.format;
    const format = typeof name === "string" ? options.formats?.[name] : undefined;
    if (typeof name !== "string") {
      problems.push(`${child("format")}: expected a string`);
      failed = true;
    } else if (!format || !Object.hasOwn(options.formats!, name)) {
      problems.push(
        `${child("format")}: unknown format ${JSON.stringify(name)}; pass a check for it in the formats option`,
      );
      failed = true;
    } else {
      checks.format = { name, test: formatTest(format) };
    }
  }
  if (failed) return null;
  return Object.keys(checks).length > 0 ? checks : undefined;
}

function formatTest(format: JSONSchemaFormat): (value: string) => boolean {
  if (format === true) return () => true;
  if (format instanceof RegExp) {
    // A `g` or `y` regex keeps `lastIndex` between calls, so the second value
    // tested would start halfway in. Reset it every time.
    return (value) => {
      format.lastIndex = 0;
      return format.test(value);
    };
  }
  return format;
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
  /**
   * Any JSON value, constrained by nothing — for a format the rest of this
   * builder cannot describe: a record with arbitrary keys, a mixed-type tuple,
   * a document that nests into itself.
   *
   * A schema containing one cannot be sent under strict mode, so a tool whose
   * input uses it is sent with `strict: false` automatically. That is not an
   * option to pass anywhere; it is read back off the schema by
   * `supportsStrict`. The rest of the tool is unaffected, and so is streaming:
   * partial arguments are parsed from the raw text, never through a schema.
   *
   * `T` is an assertion, not a guarantee. The emitted schema constrains
   * nothing, so nothing checks the model's output against `T` — only that it is
   * JSON. Validate it in `execute` and hand the model back an error it can fix,
   * the way it would any other bad argument. `describe()` is where you tell it
   * the format; with no constraints to read, that prose is all it gets.
   *
   * TWO CALL SIGNATURES, NOT A DEFAULT TYPE PARAMETER, and that is load-bearing.
   * Written `json<T = JsonValue>()`, the default lost to the surrounding
   * contextual type in the position this is actually used: `s.object`'s shape is
   * constrained to `Record<string, AnySchema>` — `Schema<any>` — which supplies
   * `any` as an inference candidate, and a candidate beats a default. So
   * `s.object({ definition: s.json() })` inferred `{ definition: any }`, which is
   * type checking switched off around exactly the field this exists for, and the
   * opposite of what the default was written to prevent. An overload with no type
   * parameter has nothing to infer, so `s.json()` is `JsonValue` wherever it is
   * written.
   *
   * `ai:generate-client` maps it to the native `JSONValue` and says nothing about
   * it. `JsonValue` is a union of every JSON shape, so it used to reach the
   * generator's "a union that is not told apart by one string member" warning —
   * true, and a misdescription of a field that is free-form on purpose. The
   * extractor recognises it now.
   */
  json(): SchemaBuilder<JsonValue>;
  json<T>(): SchemaBuilder<T>;
  /**
   * A schema read from a JSON Schema at runtime — for a shape that comes from
   * data rather than code, like a collection whose items a user defined.
   *
   * Only the subset `s` itself models is accepted, so the result stays
   * strict-mode safe and can be a tool's `inputSchema` like any other:
   *
   * - `type`: `string`, `number`, `integer`, `boolean`, `object`, `array`,
   *   or one of them with `"null"` (`["string", "null"]`).
   * - `enum` (strings become `s.enum`, numbers and booleans a union of
   *   literals; a `null` in it makes the field nullable), `const`, `anyOf`.
   * - strings: `minLength`, `maxLength`, `format` (checked with
   *   `options.formats`). Numbers: `minimum`, `maximum`, `exclusiveMinimum`,
   *   `exclusiveMaximum`. Arrays: `items` (one schema), `minItems`, `maxItems`.
   * - objects: `properties`, `required`, `additionalProperties: false`. A
   *   property not in `required` is `optional()`.
   * - `description`; annotations (`title`, `default`, `examples`, `$schema`,
   *   `x-*`, … and `options.ignoreKeywords`) are skipped.
   *
   * Anything else — `pattern`, `oneOf`, `allOf`, `$ref`, a tuple, an open
   * `additionalProperties`, an unknown `format` — throws a `JSONSchemaError`
   * listing every problem with its path.
   *
   * The length, range, item-count and format constraints are enforced by
   * `parse`/`safeParse`/`validate` and told to the model in the field's
   * description, because strict structured output does not accept them as
   * keywords. Unlike Ajv, an unknown key in an object is dropped from the
   * parsed value rather than reported.
   *
   * The output type is `JsonValue` (or the `T` you assert). Validate a value
   * with `.validate(value)` for per-path issues, or `.safeParse(value)`.
   */
  fromJSONSchema(schema: unknown, options?: FromJSONSchemaOptions): SchemaBuilder<JsonValue>;
  fromJSONSchema<T>(schema: unknown, options?: FromJSONSchemaOptions): SchemaBuilder<T>;
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
  // A union is legal wherever a property is, but not as the root of a tool's
  // input or an agent's structured output: the provider wants an object there.
  // `s` cannot know where a schema will be used, so `AgentTool.create` and
  // `Agent.create` are what reject it at the root.
  union: (members) =>
    make<Infer<(typeof members)[number]>>(
      leaf({ kind: "union", members: members.map(definitionOf) }),
    ),
  json: <T>() => make<T>(leaf({ kind: "json" })),
  fromJSONSchema: <T>(schema: unknown, options: FromJSONSchemaOptions = {}) => {
    const problems: string[] = [];
    const definition = fromJSON(schema, options, "", problems);
    if (!definition || problems.length > 0) {
      throw new JSONSchemaError(problems.length > 0 ? problems : ["unreadable schema"]);
    }
    return make<T>(definition);
  },
};

/**
 * Whether a schema can be sent under a provider's strict mode.
 *
 * False exactly when a `json()` node is somewhere inside it. Strict mode's
 * bargain is that every node constrains its value; an unconstrained one has no
 * spelling there, and sending it anyway is a 400 naming a path.
 *
 * Derived from the tree rather than declared alongside it, because the two
 * would drift: a field added to a tool's input a year from now would need
 * whoever adds it to know that a flag somewhere else describes it. Adding the
 * field is the whole of turning strict off.
 */
export function supportsStrict(schema: AnySchema): boolean {
  const definition = definitions.get(schema);
  if (definition) return strictNode(definition.node);
  // A schema built by hand rather than with `s`: `questionSchema` in
  // `ai/Agent.ts`, and the merged one `services/mcp` casts together.
  //
  // Answering `true` here was wrong, and not harmlessly. `McpRegistry`'s
  // `combineSchemas` spreads `meta.input.toJSONSchema()` into its own object,
  // so an `s.json()` field an app declared on an `mcp` route survives into the
  // emitted schema while the *tree* that would have reported it is discarded.
  // Every MCP-projected tool was therefore sent `strict: true` with an empty
  // subschema inside it — a 400 on every turn, from the one path this function
  // exists to get right.
  //
  // So the emitted schema is read instead. It is the same question asked of the
  // artifact rather than the source, which is the only thing a foreign schema
  // has to offer.
  return strictJSONSchema(schema.toJSONSchema());
}

/**
 * Whether an already-emitted JSON Schema constrains every value it describes.
 *
 * Only for schemas with no definition tree. It answers a narrower question than
 * `strictNode` — it cannot see optionality or a builder's intent, just whether
 * some node says nothing about its value — but that is exactly the property
 * strict mode rejects, and it is visible in the artifact.
 */
function strictJSONSchema(schema: JSONSchema): boolean {
  // `description` is prose, not a constraint. A node carrying only that — which
  // is what `s.json().describe(...)` emits — says nothing about its value.
  const constrained =
    schema.type !== undefined ||
    schema.enum !== undefined ||
    schema.const !== undefined ||
    schema.anyOf !== undefined ||
    schema.properties !== undefined ||
    schema.items !== undefined;
  if (!constrained) return false;

  for (const child of Object.values(schema.properties ?? {})) {
    if (!strictJSONSchema(child)) return false;
  }
  if (schema.items && !strictJSONSchema(schema.items)) return false;
  for (const member of schema.anyOf ?? []) {
    if (!strictJSONSchema(member)) return false;
  }
  return true;
}

/**
 * Enumerated rather than defaulted, so that a node kind added later cannot
 * inherit "strict" by omission — which is the failure that shows up as a 400
 * from the provider rather than as a type error here.
 *
 * Needs no cycle guard: a definition tree is built bottom-up out of finished
 * builders, so nothing in it can refer to something still being constructed.
 */
function strictNode(node: SchemaNode): boolean {
  switch (node.kind) {
    case "string":
    case "number":
    case "boolean":
    case "literal":
    case "enum":
      return true;
    case "object":
      return Object.values(node.shape).every((child) => strictNode(child.node));
    case "array":
      return strictNode(node.item.node);
    case "union":
      return node.members.every((member) => strictNode(member.node));
    case "json":
      return false;
  }
}
