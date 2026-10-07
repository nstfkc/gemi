import { app } from "../foundation/app";
import {
  DecryptionError,
  Encrypter,
  EncryptionKeyError,
} from "../services/encryption/Encrypter";
import { InvalidArgumentError, UnsupportedByDesignError } from "./errors";
import * as registry from "./registry";
import type { ModelSchema } from "./schema";

/**
 * Encrypted columns: a `String` field marked `/// @gemi.encrypted` in the
 * Prisma schema is stored as an `Encrypter` envelope and read back as the
 * plaintext.
 *
 * Applied in `Model.$exec`, per model, at the two places a value crosses the
 * boundary:
 *
 * - **Writes** encrypt the model's *own* columns in `data` (and an upsert's
 *   `create` / `update`). A nested write into a related model is not touched
 *   here: every nested write runs through the related model's own `$exec`,
 *   which encrypts its own columns, so encrypting it here as well would
 *   encrypt it twice.
 * - **Reads** decrypt the model's own rows after shaping. A batched `include`
 *   comes back through the child's `$exec` and is already decrypted; a folded
 *   (lateral) one never enters it, so the parent decrypts those rows on the
 *   child's behalf (`decryptFolded`) — the same split `redactFolded` handles
 *   for policies.
 *
 * The schema, not the model class, says which columns are encrypted. That is
 * deliberate: a column that is encrypted when written through `FigmaConnection`
 * and plaintext when written through `FigmaConnectionModel` is not encrypted
 * at rest. The generated base, the subclass and every `Model.on(...)` variant
 * share one `$schema`, so none of them can write the column in the clear.
 *
 * A filter, sort or grouping on an encrypted column is refused: every write
 * stores a different random ciphertext, so the database cannot compare it to
 * anything. A null check is the exception, because a NULL column is stored as
 * NULL.
 */

const fieldsBySchema = new WeakMap<ModelSchema, readonly string[]>();

/** The schema's encrypted fields, in declaration order. Empty for most models. */
export function encryptedFields(schema: ModelSchema): readonly string[] {
  let fields = fieldsBySchema.get(schema);
  if (fields === undefined) {
    fields = Object.values(schema.fields)
      .filter((field) => field.encrypted === true)
      .map((field) => field.name);
    fieldsBySchema.set(schema, fields);
  }
  return fields;
}

/** `Model.field` for every encrypted column of every registered model. */
export function encryptedColumnsInRegistry(): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const name of registry.registeredNames()) {
    const schema = schemaOf(name);
    if (!schema || seen.has(schema.name)) continue;
    seen.add(schema.name);
    for (const field of encryptedFields(schema)) columns.push(`${schema.name}.${field}`);
  }
  return columns;
}

/**
 * The application's `Encrypter`. An application booted without the
 * framework's providers (a test harness that binds only the database) gets a
 * typed error naming the fix rather than a container error.
 */
export function currentEncrypter(): Encrypter {
  const application = app();
  if (!application.bound(Encrypter)) {
    throw new EncryptionKeyError(
      "Encrypted columns need an Encrypter, and none is bound in this " +
        "application. A booted Kernel binds one from the `encryption` config " +
        "slice; a hand-built Application can bind its own: " +
        "`application.instance(Encrypter, new Encrypter({ keys: { k1: key } }))`.",
    );
  }
  return application.make(Encrypter);
}

// --- the internal raw mode ---------------------------------------------------

/**
 * Marks an `$exec` call as reading and writing encrypted columns *as stored*:
 * no decryption of results, no encryption of `data`, and filters on encrypted
 * columns allowed (compared against the envelope). Used by `encryption:rotate`
 * to compare-and-swap one envelope for another. A module-private symbol, like
 * the other `$exec` markers, so an application cannot set it.
 */
const RAW = Symbol("gemi.orm.encryptedColumnsRaw");

export function markEncryptionRaw<T extends object>(options: T): T {
  return { ...options, [RAW]: true };
}

export function isEncryptionRaw(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as Record<symbol, unknown>)[RAW] === true
  );
}

// --- refusing filters --------------------------------------------------------

interface Origin {
  model: string;
  operation: string;
}

/**
 * Refuses any argument that would make the database compare, sort or group an
 * encrypted column: `where` (including relation filters into other models),
 * `orderBy`, `distinct`, `cursor`, `groupBy`'s `by` and `having`, the
 * `_min` / `_max` aggregates, and the same arguments nested inside an
 * `include` or `select`.
 *
 * Walked whether or not this model has encrypted columns, because a relation
 * filter or an include reaches other models'.
 */
export function assertNoEncryptedFilters(schema: ModelSchema, op: string, args: unknown): void {
  if (!isObject(args)) return;
  const origin: Origin = { model: schema.name, operation: op };
  readArgs(schema, args, origin, 0);
  for (const key of ["by", "_min", "_max", "_avg", "_sum"]) {
    if (args[key] !== undefined) fieldList(schema, args[key], key, origin);
  }
  if (args.having !== undefined) having(schema, args.having, origin);
}

/** Generous: relation depth is bounded by `MAX_RELATION_DEPTH` long before this. */
const MAX_WALK_DEPTH = 64;

function readArgs(schema: ModelSchema, args: Record<string, any>, origin: Origin, depth: number) {
  if (depth > MAX_WALK_DEPTH) return;
  if (args.where !== undefined) where(schema, args.where, "where", origin, depth);
  if (args.cursor !== undefined) where(schema, args.cursor, "cursor", origin, depth);
  if (args.orderBy !== undefined) orderBy(schema, args.orderBy, origin, depth);
  if (args.distinct !== undefined) fieldList(schema, args.distinct, "distinct", origin);

  for (const projection of [args.include, args.select]) {
    if (!isObject(projection)) continue;
    for (const [key, value] of Object.entries(projection)) {
      if (!isObject(value)) continue;
      if (key === "_count") {
        if (!isObject(value.select)) continue;
        for (const [name, count] of Object.entries(value.select)) {
          const target = relationTarget(schema, name);
          if (target && isObject(count) && count.where !== undefined) {
            where(target, count.where, "where", origin, depth + 1);
          }
        }
        continue;
      }
      const target = relationTarget(schema, key);
      if (target) readArgs(target, value, origin, depth + 1);
    }
  }
}

const RELATION_FILTERS = ["some", "every", "none", "is", "isNot"];

function where(
  schema: ModelSchema,
  node: unknown,
  argument: string,
  origin: Origin,
  depth: number,
): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) where(schema, item, argument, origin, depth);
    return;
  }
  if (!isObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;

    if (key === "AND" || key === "OR" || key === "NOT") {
      where(schema, value, argument, origin, depth);
      continue;
    }

    const field = schema.fields[key];
    if (field) {
      if (field.encrypted === true && !isNullCheck(value)) {
        refuse(schema, key, argument, origin);
      }
      continue;
    }

    const target = relationTarget(schema, key);
    if (target) {
      if (!isObject(value)) continue;
      const filters = Object.keys(value).filter((name) => RELATION_FILTERS.includes(name));
      if (filters.length > 0) {
        for (const name of filters) where(target, value[name], argument, origin, depth + 1);
      } else {
        where(target, value, argument, origin, depth + 1);
      }
      continue;
    }

    // A compound unique key — `provider_providerId: { provider, providerId }`.
    if (isObject(value)) {
      for (const name of Object.keys(value)) {
        if (schema.fields[name]?.encrypted === true) refuse(schema, name, argument, origin);
      }
    }
  }
}

function orderBy(schema: ModelSchema, node: unknown, origin: Origin, depth: number): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) orderBy(schema, item, origin, depth);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (schema.fields[key]?.encrypted === true) refuse(schema, key, "orderBy", origin);
    const target = relationTarget(schema, key);
    if (target && isObject(value) && !("_count" in value)) {
      orderBy(target, value, origin, depth + 1);
    }
  }
}

/** `distinct`, `by`, and the `_min` / `_max` / `_avg` / `_sum` selections. */
function fieldList(schema: ModelSchema, node: unknown, argument: string, origin: Origin): void {
  const names =
    typeof node === "string"
      ? [node]
      : Array.isArray(node)
        ? node.filter((name): name is string => typeof name === "string")
        : isObject(node)
          ? Object.keys(node).filter((name) => node[name])
          : [];
  for (const name of names) {
    if (schema.fields[name]?.encrypted === true) refuse(schema, name, argument, origin);
  }
}

function having(schema: ModelSchema, node: unknown, origin: Origin): void {
  if (Array.isArray(node)) {
    for (const item of node) having(schema, item, origin);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "AND" || key === "OR" || key === "NOT") {
      having(schema, value, origin);
      continue;
    }
    if (schema.fields[key]?.encrypted === true && !isNullCheck(value)) {
      refuse(schema, key, "having", origin);
    }
  }
}

/** `null`, `{ equals: null }`, `{ not: null }` — the only comparisons a ciphertext supports. */
function isNullCheck(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const entries = Object.entries(value).filter(([, operand]) => operand !== undefined);
  return (
    entries.length > 0 &&
    entries.every(([operator, operand]) => (operator === "equals" || operator === "not") && operand === null)
  );
}

function refuse(schema: ModelSchema, field: string, argument: string, origin: Origin): never {
  throw new UnsupportedByDesignError(
    argument,
    origin.model,
    origin.operation,
    `${schema.name}.${field} is an encrypted column: each write stores a ` +
      `different random ciphertext, so the database cannot compare, sort or ` +
      `group by it. Only null checks work on it ({ ${field}: null } or ` +
      `{ ${field}: { not: null } }). To look a row up by a secret, store a ` +
      `keyed hash of it in a separate column and filter on that.`,
  );
}

// --- writes ------------------------------------------------------------------

/**
 * `args` with this model's encrypted columns encrypted, or `args` itself when
 * there is nothing to encrypt. Never mutates the caller's objects: the same
 * `data` may be reused for a second call.
 *
 * Only `data` (and an upsert's `create` / `update`) at this level. Nested
 * relation writes are left as they are; see the note at the top of the file.
 */
export function encryptWriteArgs(schema: ModelSchema, op: string, args: any): any {
  const fields = encryptedFields(schema);
  if (fields.length === 0 || !isObject(args)) return args;

  const origin: Origin = { model: schema.name, operation: op };
  let encrypter: Encrypter | undefined;
  const encrypt = (value: string) => (encrypter ??= currentEncrypter()).encrypt(value);

  let next = args;
  const replace = (key: string, value: unknown) => {
    if (value === next[key]) return;
    if (next === args) next = { ...args };
    next[key] = value;
  };

  switch (op) {
    case "create":
    case "update":
    case "updateMany":
      replace("data", encryptData(fields, args.data, encrypt, origin));
      break;
    case "createMany":
      replace(
        "data",
        Array.isArray(args.data)
          ? mapIfChanged(args.data, (row) => encryptData(fields, row, encrypt, origin))
          : encryptData(fields, args.data, encrypt, origin),
      );
      break;
    case "upsert":
      replace("create", encryptData(fields, args.create, encrypt, origin));
      replace("update", encryptData(fields, args.update, encrypt, origin));
      break;
  }
  return next;
}

function encryptData(
  fields: readonly string[],
  data: unknown,
  encrypt: (value: string) => string,
  origin: Origin,
): unknown {
  if (!isObject(data)) return data;
  let copy: Record<string, unknown> | undefined;
  for (const name of fields) {
    if (!(name in data)) continue;
    const value = data[name];
    const next = encryptValue(name, value, encrypt, origin);
    if (next !== value) (copy ??= { ...data })[name] = next;
  }
  return copy ?? data;
}

function encryptValue(
  field: string,
  value: unknown,
  encrypt: (value: string) => string,
  origin: Origin,
): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return encrypt(value);
  // Prisma's `{ set: value }` spelling of a scalar update.
  if (isObject(value) && Object.keys(value).length === 1 && "set" in value) {
    const set = value.set;
    return set === null || set === undefined ? value : { set: encryptValue(field, set, encrypt, origin) };
  }
  throw new InvalidArgumentError(
    "data",
    origin.model,
    origin.operation,
    `${origin.model}.${field} is an encrypted column and takes a string or ` +
      `null (or { set: string | null }); got ${describe(value)}.`,
  );
}

function mapIfChanged<T>(items: T[], fn: (item: T) => T): T[] {
  let copy: T[] | undefined;
  items.forEach((item, index) => {
    const next = fn(item);
    if (next !== item) (copy ??= [...items])[index] = next;
  });
  return copy ?? items;
}

// --- reads -------------------------------------------------------------------

/**
 * Decrypts this model's encrypted columns on `rows`, in place. A value that
 * does not decrypt raises `DecryptionError` naming the column — a ciphertext
 * is never handed back as if it were the value.
 */
export function decryptRows(schema: ModelSchema, rows: readonly unknown[]): void {
  const fields = encryptedFields(schema);
  if (fields.length === 0 || rows.length === 0) return;

  let encrypter: Encrypter | undefined;
  for (const row of rows) {
    if (!isObject(row)) continue;
    for (const field of fields) {
      const value = row[field];
      if (typeof value !== "string") continue;
      encrypter ??= currentEncrypter();
      try {
        row[field] = encrypter.decrypt(value);
      } catch (error) {
        if (error instanceof DecryptionError) {
          error.column = { model: schema.name, field };
          error.message = `Could not decrypt ${schema.name}.${field}: ${error.message}`;
        }
        throw error;
      }
    }
  }
}

/**
 * Decrypts the rows a strategy folded into the parent's statement, which never
 * passed through their own model's `$exec`. Recursive, because the fold is.
 */
export function decryptFolded(
  relation: { as: string; model: string; folded?: readonly { as: string; model: string; folded?: readonly unknown[] }[] },
  parents: readonly unknown[],
): void {
  const schema = schemaOf(relation.model);
  const rows: unknown[] = [];
  for (const parent of parents) {
    if (!isObject(parent)) continue;
    const value = parent[relation.as];
    if (Array.isArray(value)) rows.push(...value);
    else if (isObject(value)) rows.push(value);
  }
  if (rows.length === 0) return;
  if (schema) decryptRows(schema, rows);
  for (const child of relation.folded ?? []) {
    decryptFolded(child as Parameters<typeof decryptFolded>[0], rows);
  }
}

// --- helpers -----------------------------------------------------------------

function schemaOf(model: string): ModelSchema | undefined {
  if (!registry.has(model)) return undefined;
  return registry.get<{ $schema?: ModelSchema }>(model).$schema;
}

function relationTarget(schema: ModelSchema, name: string): ModelSchema | undefined {
  const relation = schema.relations[name];
  return relation ? schemaOf(relation.model) : undefined;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "a Date";
  return `a ${typeof value}`;
}
