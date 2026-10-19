import { InvalidArgumentError } from "./errors";
import { jsonNullKind } from "./json-null";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

/**
 * Typed `Json` columns (#995): a schema per column, declared once on the
 * model's class, parsed on every read and validated on every write.
 *
 * ```ts
 * export class PageBrief extends PageBriefModel {
 *   static $json = {
 *     heroes: s.array(HeroSchema),
 *     styles: { schema: s.array(StyleSchema), invalid: "null" },
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

interface Column {
  field: string;
  nullable: boolean;
  schema: JsonColumnSchema;
  invalid: JsonColumnInvalid<unknown>;
}

const columnsByClass = new WeakMap<object, readonly Column[]>();
const NONE: readonly Column[] = [];

/**
 * The model's typed `Json` columns, from the class registered under its name
 * (else `fallback`, the class `$exec` was called on). Checked once per class:
 * a key that is not a `Json` column of the model, or a value that is not a
 * schema, throws.
 */
export function jsonColumnsOf(schema: ModelSchema, fallback: object): readonly Column[] {
  const owner = (registry.has(schema.name) ? registry.get<object>(schema.name) : fallback) as {
    $json?: unknown;
  };
  const cached = columnsByClass.get(owner);
  if (cached) return cached;

  const specs = owner.$json;
  let columns: readonly Column[] = NONE;
  if (specs !== undefined && specs !== null) {
    if (typeof specs !== "object") {
      throw new TypeError(`${schema.name}.$json must be an object of column schemas.`);
    }
    columns = Object.entries(specs as Record<string, unknown>).map(([field, spec]) =>
      columnOf(schema, field, spec),
    );
  }
  columnsByClass.set(owner, columns);
  return columns;
}

function columnOf(schema: ModelSchema, field: string, spec: unknown): Column {
  const where = `${schema.name}.$json.${field}`;
  const column = schema.fields[field];
  if (!column || column.type !== "Json" || column.isList) {
    throw new TypeError(
      `${where}: ${schema.name} has no \`Json\` column named "${field}". ` +
        `\`static $json\` declares schemas for the model's own (non-list) Json columns.`,
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
    field,
    nullable: column.nullable,
    schema: inner,
    invalid: invalid as JsonColumnInvalid<unknown>,
  };
}

// --- reads -------------------------------------------------------------------

/** Parses this model's typed `Json` columns on `rows`, in place. */
export function parseJsonRows(
  columns: readonly Column[],
  model: string,
  rows: readonly unknown[],
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
      row[column.field] = parseStored(column, model, value);
    }
  }
}

function parseStored(column: Column, model: string, value: unknown): unknown {
  const result = column.schema.safeParse(value);
  if (result.ok) return result.value;
  const { errors } = result as { errors: string[] };
  if (column.invalid === "null") return null;
  if (typeof column.invalid === "function") return column.invalid(value, errors);
  throw new JsonColumnError({ model, field: column.field }, value, errors);
}

/**
 * Parses the rows a strategy folded into the parent's statement, which never
 * passed through their own model's `$exec`. Recursive, because the fold is.
 */
export function parseJsonFolded(
  relation: {
    as: string;
    model: string;
    folded?: readonly { as: string; model: string; folded?: readonly unknown[] }[];
  },
  parents: readonly unknown[],
): void {
  const rows: unknown[] = [];
  for (const parent of parents) {
    if (!isObject(parent)) continue;
    const value = parent[relation.as];
    if (Array.isArray(value)) rows.push(...value);
    else if (isObject(value)) rows.push(value);
  }
  if (rows.length === 0) return;
  if (registry.has(relation.model)) {
    const model = registry.get<{ $schema?: ModelSchema }>(relation.model);
    if (model.$schema) parseJsonRows(jsonColumnsOf(model.$schema, model), relation.model, rows);
  }
  for (const child of relation.folded ?? []) {
    parseJsonFolded(child as Parameters<typeof parseJsonFolded>[0], rows);
  }
}

// --- writes ------------------------------------------------------------------

/**
 * `args` with this model's typed `Json` columns validated and replaced by
 * their parsed values, or `args` itself when there is nothing to check. Never
 * mutates the caller's objects. A value the schema refuses throws
 * `InvalidArgumentError`; the null sentinels (`DbNull`, `JsonNull`) pass.
 */
export function validateJsonWriteArgs(
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
  const data = (value: unknown, argument: string) =>
    validateData(columns, value, { model, operation: op, argument });

  switch (op) {
    case "create":
    case "update":
    case "updateMany":
      replace("data", data(args.data, "data"));
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
      replace("update", data(args.update, "update"));
      break;
  }
  return next;
}

function validateData(
  columns: readonly Column[],
  data: unknown,
  origin: { model: string; operation: string; argument: string },
): unknown {
  if (!isObject(data)) return data;
  let copy: Record<string, unknown> | undefined;
  for (const column of columns) {
    if (!(column.field in data)) continue;
    const value = data[column.field];
    if (value === undefined || jsonNullKind(value) !== null) continue;
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
