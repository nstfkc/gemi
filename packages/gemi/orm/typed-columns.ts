import { InvalidArgumentError } from "./errors";
import { jsonNullKind } from "./json-null";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

/**
 * Typed columns: a schema per column, declared once on the model's class,
 * parsed on every read and validated on every write. Two declarations share
 * this module:
 *
 * - `static $json` (#995) for `Json` columns: documents, with Prisma's
 *   `DbNull` / `JsonNull` markers.
 * - `static $columns` (#1001) for scalar (`String`) columns: ids into a
 *   code-side catalogue, read as the catalogue's union. `where` keeps the
 *   column's own filter, and an update's `{ set: value }` is validated too.
 *
 * ```ts
 * export class PageBrief extends PageBriefModel {
 *   static $json = {
 *     heroes: s.array(HeroSchema),
 *     styles: { schema: s.array(StyleSchema), invalid: "null" },
 *   };
 *   static $columns = {
 *     designStyle: { schema: s.enum(DESIGN_STYLE_IDS), invalid: "null" },
 *   };
 * }
 * ```
 *
 * Applied in `Model.$exec` at the same two places as encrypted columns:
 *
 * - **Writes** validate the model's *own* columns in `data` (and an upsert's
 *   `create` / `update`), and write the parsed value. A nested write into a
 *   related model runs through that model's own `$exec`, which validates its
 *   own columns.
 * - **Reads** parse the model's own rows after shaping, and the rows of a
 *   folded (lateral) include on the child's behalf, since those never enter
 *   the child's `$exec`.
 *
 * The schemas are read from the class *registered* under the model's name,
 * not from `this`: the generated base, the app's subclass and every
 * `Model.on(...)` variant share one set of columns, and a read through the
 * generated base must not hand back an unparsed value the types call parsed.
 *
 * A schema is anything with gemi's `safeParse` (`s` from `gemi/ai`):
 * `{ ok: true, value } | { ok: false, errors }`. Only the parsed `value` is
 * written or returned, so keys the schema does not know are stripped.
 */

/** What `safeParse` answers. The shape of gemi's `s` schemas. */
export type JsonSchemaResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** A schema a `Json` column can be declared with: gemi's `s` builders, or anything shaped like them. */
export interface JsonColumnSchema<T = unknown> {
  parse(value: unknown): T;
  safeParse(value: unknown): JsonSchemaResult<T>;
}

/**
 * What a read does with a stored value the schema refuses: `"throw"` (the
 * default) raises `JsonColumnError`; `"null"` answers `null`; a function
 * answers its own value (a fallback for rows written before the shape
 * changed).
 */
export type JsonColumnInvalid<T> = "throw" | "null" | ((value: unknown, errors: string[]) => T);

/** One column's declaration: a schema, or a schema with what to do with a stored value it refuses. */
export type JsonColumnSpec<T = any> =
  | JsonColumnSchema<T>
  | { schema: JsonColumnSchema<T>; invalid?: JsonColumnInvalid<T> };

/** `static $json` on a model: a column name to its declaration. */
export type JsonColumnSpecs = Record<string, JsonColumnSpec>;

/**
 * One scalar column's declaration in `static $columns` (#1001): the same
 * shape as a `Json` column's, a schema or `{ schema, invalid }`.
 */
export type ScalarColumnSpec<T = any> = JsonColumnSpec<T>;

/** `static $columns` on a model: a column name to its declaration. */
export type ScalarColumnSpecs = Record<string, ScalarColumnSpec>;

/**
 * A stored `Json` value its column's schema refused on a read, with
 * `invalid: "throw"` (the default).
 */
export class JsonColumnError extends Error {
  constructor(
    public readonly column: { model: string; field: string },
    public readonly value: unknown,
    public readonly errors: string[],
  ) {
    super(
      `The stored value of ${column.model}.${column.field} does not match its ` +
        `schema: ${errors.join("; ")}. Give the column a fallback ` +
        `(\`{ schema, invalid: (value) => ... }\` or \`invalid: "null"\`) for ` +
        `rows written before the shape changed, or fix the rows.`,
    );
    this.name = "JsonColumnError";
  }
}

/**
 * A stored value in a typed scalar column (`static $columns`) that its schema
 * refused on a read, with `invalid: "throw"` (the default).
 */
export class ScalarColumnError extends Error {
  constructor(
    public readonly column: { model: string; field: string },
    public readonly value: unknown,
    public readonly errors: string[],
  ) {
    super(
      `The stored value of ${column.model}.${column.field} does not match its ` +
        `schema: ${errors.join("; ")}. Give the column a fallback ` +
        `(\`{ schema, invalid: (value) => ... }\` or \`invalid: "null"\`) for ` +
        `rows holding a value the schema no longer accepts, or fix the rows.`,
    );
    this.name = "ScalarColumnError";
  }
}

/** Which declaration a column came from: `$json` or `$columns`. */
type Kind = "json" | "scalar";

interface Column {
  kind: Kind;
  field: string;
  nullable: boolean;
  schema: JsonColumnSchema;
  invalid: JsonColumnInvalid<unknown>;
}

const columnsByClass = new WeakMap<object, readonly Column[]>();
const NONE: readonly Column[] = [];

/** The column types `static $columns` accepts. `String` for now (#1001). */
const SCALAR_TYPES = new Set(["String"]);

/**
 * The model's typed columns (`$json` and `$columns`), from the class
 * registered under its name (else `fallback`, the class `$exec` was called
 * on). Checked once per class: a key that is not a column of the right type,
 * or a value that is not a schema, throws.
 */
export function typedColumnsOf(schema: ModelSchema, fallback: object): readonly Column[] {
  const owner = (registry.has(schema.name) ? registry.get<object>(schema.name) : fallback) as {
    $json?: unknown;
    $columns?: unknown;
  };
  const cached = columnsByClass.get(owner);
  if (cached) return cached;

  const columns = [
    ...columnsFrom(schema, "json", owner.$json),
    ...columnsFrom(schema, "scalar", owner.$columns),
  ];
  const result = columns.length === 0 ? NONE : columns;
  columnsByClass.set(owner, result);
  return result;
}

function columnsFrom(schema: ModelSchema, kind: Kind, specs: unknown): Column[] {
  if (specs === undefined || specs === null) return [];
  if (typeof specs !== "object") {
    throw new TypeError(`${schema.name}.${staticName(kind)} must be an object of column schemas.`);
  }
  return Object.entries(specs as Record<string, unknown>).map(([field, spec]) =>
    columnOf(schema, kind, field, spec),
  );
}

function staticName(kind: Kind): string {
  return kind === "json" ? "$json" : "$columns";
}

function columnOf(schema: ModelSchema, kind: Kind, field: string, spec: unknown): Column {
  const where = `${schema.name}.${staticName(kind)}.${field}`;
  const column = schema.fields[field];
  if (kind === "json" && (!column || column.type !== "Json" || column.isList)) {
    throw new TypeError(
      `${where}: ${schema.name} has no \`Json\` column named "${field}". ` +
        `\`static $json\` declares schemas for the model's own (non-list) Json columns` +
        (column && SCALAR_TYPES.has(column.type) && !column.isList
          ? `; declare a \`${column.type}\` column in \`static $columns\`.`
          : "."),
    );
  }
  if (kind === "scalar" && (!column || !SCALAR_TYPES.has(column.type) || column.isList)) {
    throw new TypeError(
      `${where}: ${schema.name} has no \`String\` column named "${field}". ` +
        `\`static $columns\` declares schemas for the model's own (non-list) String columns` +
        (column?.type === "Json" && !column.isList
          ? `; declare a \`Json\` column in \`static $json\`.`
          : "."),
    );
  }
  const inner = isSchema(spec) ? spec : isObject(spec) ? spec.schema : undefined;
  if (!isSchema(inner)) {
    throw new TypeError(
      `${where} must be a schema (\`s.object(...)\` from gemi/ai) or \`{ schema, invalid }\`.`,
    );
  }
  const invalid = isSchema(spec) ? "throw" : ((spec as { invalid?: unknown }).invalid ?? "throw");
  if (invalid !== "throw" && invalid !== "null" && typeof invalid !== "function") {
    throw new TypeError(`${where}.invalid must be "throw", "null" or a function.`);
  }
  return {
    kind,
    field,
    nullable: column!.nullable,
    schema: inner,
    invalid: invalid as JsonColumnInvalid<unknown>,
  };
}

// --- reads -------------------------------------------------------------------

/**
 * Marks an `$exec` call whose rows belong to a write: the rows a write returns,
 * the read a find-then-write upsert or a delete makes first, and the includes
 * on any of them. In this mode a stored value the schema refuses never throws,
 * even with `invalid: "throw"`: it is answered as stored. Throwing there would
 * report a write as failed after it was saved (or refuse to delete or fix a
 * bad row), and only a column the write did not touch can hold such a value,
 * since the written ones were validated. A module-private symbol, like the
 * other `$exec` markers.
 */
const LENIENT = Symbol("gemi.orm.typedColumnsLenient");

export function markLenient<T extends object>(options: T): T {
  return { ...options, [LENIENT]: true };
}

export function isLenient(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as Record<symbol, unknown>)[LENIENT] === true
  );
}

/**
 * Parses this model's typed columns on `rows`, in place. `lenient`: see
 * `markLenient`.
 */
export function parseTypedRows(
  columns: readonly Column[],
  model: string,
  rows: readonly unknown[],
  lenient = false,
): void {
  if (columns.length === 0 || rows.length === 0) return;
  for (const row of rows) {
    if (!isObject(row)) continue;
    for (const column of columns) {
      if (!(column.field in row)) continue;
      const value = row[column.field];
      // SQL NULL in a nullable column is the column's own empty state, not a
      // value of the schema's shape.
      if (value === null && column.nullable) continue;
      row[column.field] = parseStored(column, model, value, lenient);
    }
  }
}

function parseStored(column: Column, model: string, value: unknown, lenient: boolean): unknown {
  const result = column.schema.safeParse(value);
  if (result.ok) return result.value;
  const { errors } = result as { errors: string[] };
  if (column.invalid === "null") return null;
  if (typeof column.invalid === "function") return column.invalid(value, errors);
  if (lenient) return value;
  const ErrorClass = column.kind === "json" ? JsonColumnError : ScalarColumnError;
  throw new ErrorClass({ model, field: column.field }, value, errors);
}

/**
 * Parses the rows a strategy folded into the parent's statement, which never
 * passed through their own model's `$exec`. Recursive, because the fold is.
 */
export function parseTypedFolded(
  relation: {
    as: string;
    model: string;
    folded?: readonly { as: string; model: string; folded?: readonly unknown[] }[];
  },
  parents: readonly unknown[],
  lenient = false,
): void {
  const model = registry.has(relation.model)
    ? registry.get<{ $schema?: ModelSchema }>(relation.model)
    : undefined;
  const columns = model?.$schema ? typedColumnsOf(model.$schema, model) : [];
  // Nothing to parse here or below: the common case, a child without typed columns.
  if (columns.length === 0 && !relation.folded?.length) return;

  const rows: unknown[] = [];
  for (const parent of parents) {
    if (!isObject(parent)) continue;
    const value = parent[relation.as];
    if (Array.isArray(value)) rows.push(...value);
    else if (isObject(value)) rows.push(value);
  }
  if (rows.length === 0) return;
  parseTypedRows(columns, relation.model, rows, lenient);
  for (const child of relation.folded ?? []) {
    parseTypedFolded(child as Parameters<typeof parseTypedFolded>[0], rows, lenient);
  }
}

// --- writes ------------------------------------------------------------------

/**
 * `args` with this model's typed columns validated and replaced by their
 * parsed values, or `args` itself when there is nothing to check. Never
 * mutates the caller's objects. A value the schema refuses throws
 * `InvalidArgumentError`.
 *
 * `Json` columns: on a nullable column the null sentinels (`DbNull`,
 * `JsonNull`) pass. On a non-nullable one `DbNull` is refused, and `JsonNull`
 * only passes when the schema accepts `null`: otherwise the row could be
 * written and then never read.
 *
 * Scalar columns: `null` passes on a nullable column and is refused on a
 * non-nullable one. An update's `{ set: value }` is validated like `value`.
 */
export function validateTypedWriteArgs(
  columns: readonly Column[],
  model: string,
  op: string,
  args: any,
): any {
  if (columns.length === 0 || !isObject(args)) return args;

  let next = args;
  const replace = (key: string, value: unknown) => {
    if (value === next[key]) return;
    if (next === args) next = { ...args };
    next[key] = value;
  };
  const data = (value: unknown, argument: string, update = false) =>
    validateData(columns, value, { model, operation: op, argument }, update);

  switch (op) {
    case "create":
      replace("data", data(args.data, "data"));
      break;
    case "update":
    case "updateMany":
      replace("data", data(args.data, "data", true));
      break;
    case "createMany":
      replace(
        "data",
        Array.isArray(args.data)
          ? mapIfChanged(args.data, (row) => data(row, "data"))
          : data(args.data, "data"),
      );
      break;
    case "upsert":
      replace("create", data(args.create, "create"));
      replace("update", data(args.update, "update", true));
      break;
  }
  return next;
}

function validateData(
  columns: readonly Column[],
  data: unknown,
  origin: { model: string; operation: string; argument: string },
  update: boolean,
): unknown {
  if (!isObject(data)) return data;
  let copy: Record<string, unknown> | undefined;
  for (const column of columns) {
    if (!(column.field in data)) continue;
    const value = data[column.field];
    if (value === undefined) continue;
    if (column.kind === "scalar") {
      const next = validateScalar(column, value, origin, update);
      if (next !== value) (copy ??= { ...data })[column.field] = next;
      continue;
    }
    const kind = jsonNullKind(value);
    if (kind !== null) {
      if (column.nullable) continue;
      if (kind === "json" && column.schema.safeParse(null).ok) continue;
      throw new InvalidArgumentError(
        origin.argument,
        origin.model,
        origin.operation,
        `${origin.model}.${column.field} is not nullable and its schema does not accept null, ` +
          `so it cannot be written as ${kind === "db" ? "DbNull" : "JsonNull"}.`,
      );
    }
    const result = column.schema.safeParse(value);
    if (!result.ok) {
      throw new InvalidArgumentError(
        origin.argument,
        origin.model,
        origin.operation,
        `${origin.model}.${column.field} does not match its schema: ${(result as { errors: string[] }).errors.join("; ")}.`,
      );
    }
    if (result.value !== value) (copy ??= { ...data })[column.field] = result.value;
  }
  return copy ?? data;
}

/**
 * One scalar column's written value: `value`, or an update's `{ set: value }`
 * (the only operator a `String` column takes), validated and replaced by the
 * parsed value.
 */
function validateScalar(
  column: Column,
  value: unknown,
  origin: { model: string; operation: string; argument: string },
  update: boolean,
): unknown {
  if (update && isObject(value) && "set" in value && Object.keys(value).length === 1) {
    if (value.set === undefined) return value;
    const set = validateScalar(column, value.set, origin, false);
    return set === value.set ? value : { set };
  }
  const refuse = (reason: string) =>
    new InvalidArgumentError(
      origin.argument,
      origin.model,
      origin.operation,
      `${origin.model}.${column.field} ${reason}.`,
    );
  if (value === null) {
    if (column.nullable) return value;
    throw refuse("is not nullable");
  }
  const result = column.schema.safeParse(value);
  if (!result.ok) {
    throw refuse(`does not match its schema: ${(result as { errors: string[] }).errors.join("; ")}`);
  }
  return result.value;
}

// --- helpers -----------------------------------------------------------------

function mapIfChanged<T>(items: T[], fn: (item: T) => T): T[] {
  let copy: T[] | undefined;
  items.forEach((item, index) => {
    const next = fn(item);
    if (next !== item) (copy ??= [...items])[index] = next;
  });
  return copy ?? items;
}

function isSchema(value: unknown): value is JsonColumnSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as JsonColumnSchema).safeParse === "function" &&
    typeof (value as JsonColumnSchema).parse === "function"
  );
}

function isObject(value: unknown): value is Record<string, any> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}
