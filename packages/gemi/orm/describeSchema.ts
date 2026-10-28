// A compact description of the models, for a prompt (#1065).
//
// An AI agent that writes SQL needs to know the tables, their columns and how
// they relate, in as few tokens as possible, and the summary must not go stale
// the way a hand-pasted schema does. The generated artifact already has all of
// it, so this reads the registered schemas (or ones it is handed) and writes
// one line per model.
//
// Secrets are the other half: a column marked `/// @gemi.sensitive` (or
// encrypted, or named in `sensitive`) is marked in the summary so the model
// knows not to select it, or left out with `sensitiveColumns: "omit"`.

import * as registry from "./registry";
import type { FieldSchema, ModelSchema, RelationSchema } from "./schema";

export type DescribeSchemaOptions = {
  /**
   * The schemas to describe. Default: every registered model. Takes a list,
   * or the generated module itself (`import * as schema from
   * "./models/generated/schema"`), whose non-schema exports are skipped.
   */
  schemas?: readonly ModelSchema[] | Record<string, unknown>;
  /** Only these models, by name. Default: all of them. */
  models?: readonly string[];
  /** Models (`"Session"`) or fields (`"User.password"`) left out entirely. */
  exclude?: readonly string[];
  /**
   * Fields (`"User.verificationToken"`) to treat as sensitive, beside the ones
   * marked `/// @gemi.sensitive` and the encrypted ones.
   */
  sensitive?: readonly string[];
  /**
   * What a sensitive column looks like in the summary: `"mark"` (the
   * default) keeps it with `[sensitive]`, so the model knows it exists and
   * not to select it; `"omit"` leaves it out.
   */
  sensitiveColumns?: "mark" | "omit";
};

/** One column, as `describeSchemaModels` reports it. */
export type SchemaColumnSummary = {
  field: string;
  /** The database column, which differs from `field` under `@map`. */
  column: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** A single-column unique key. Composite ones are on the model. */
  unique: boolean;
  list: boolean;
  enum?: string;
  sensitive: boolean;
};

/** One relation, as `describeSchemaModels` reports it. */
export type SchemaRelationSummary = {
  name: string;
  model: string;
  kind: "one" | "many";
  nullable: boolean;
  /** This model's foreign key columns, on the side that holds them. */
  from: string[];
  /** The related model's columns they point at. */
  to: string[];
  /** The join table of an implicit many-to-many. */
  joinTable?: string;
};

/** One model, as `describeSchemaModels` reports it. */
export type SchemaModelSummary = {
  name: string;
  table: string;
  columns: SchemaColumnSummary[];
  relations: SchemaRelationSummary[];
  primaryKey: string[];
  /** Composite unique keys, as column names. */
  uniques: string[][];
};

/**
 * The models as data: tables, columns (database names beside field names),
 * keys and relations, with sensitive columns flagged or left out. What
 * `describeSchema` writes, for a tool that answers "describe these tables".
 */
export function describeSchemaModels(options: DescribeSchemaOptions = {}): SchemaModelSummary[] {
  const schemas = schemasFrom(options.schemas);
  const only = options.models ? new Set(options.models) : undefined;
  const excludedModels = new Set<string>();
  const excludedFields = new Set<string>();
  for (const entry of options.exclude ?? []) {
    if (entry.includes(".")) excludedFields.add(entry);
    else excludedModels.add(entry);
  }
  const sensitive = new Set(options.sensitive ?? []);
  const omit = options.sensitiveColumns === "omit";
  if (only) {
    const known = new Set(schemas.map((schema) => schema.name));
    const unknown = [...only].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `describeSchema: no model named ${unknown.map((name) => `"${name}"`).join(", ")}. ` +
          `The models are: ${[...known].join(", ")}.`,
      );
    }
  }

  const out: SchemaModelSummary[] = [];
  for (const schema of schemas) {
    if (only && !only.has(schema.name)) continue;
    if (excludedModels.has(schema.name)) continue;
    const isSensitive = (field: FieldSchema) =>
      field.sensitive === true ||
      field.encrypted === true ||
      sensitive.has(`${schema.name}.${field.name}`);
    const singleUniques = new Set(
      schema.uniques.filter((key) => key.length === 1).map((key) => key[0]),
    );
    const columnOf = (name: string) => schema.fields[name]?.column ?? name;

    const columns: SchemaColumnSummary[] = [];
    for (const field of Object.values(schema.fields)) {
      if (excludedFields.has(`${schema.name}.${field.name}`)) continue;
      const secret = isSensitive(field);
      if (secret && omit) continue;
      columns.push({
        field: field.name,
        column: field.column,
        type: field.type,
        nullable: field.nullable,
        primaryKey: schema.primaryKey.includes(field.name),
        unique: singleUniques.has(field.name),
        list: field.isList === true,
        ...(field.enum ? { enum: field.enum } : {}),
        sensitive: secret,
      });
    }

    const relations: SchemaRelationSummary[] = [];
    for (const relation of Object.values(schema.relations)) {
      if (excludedModels.has(relation.model)) continue;
      if (excludedFields.has(`${schema.name}.${relation.name}`)) continue;
      relations.push(relationSummary(relation, columnOf, schemas));
    }

    out.push({
      name: schema.name,
      table: schema.table,
      columns,
      relations,
      primaryKey: schema.primaryKey.map(columnOf),
      uniques: schema.uniques.filter((key) => key.length > 1).map((key) => key.map(columnOf)),
    });
  }
  return out;
}

/**
 * The models as prompt-ready text: one line per model, with its table, its
 * columns (`field:Type`, the database column after `@` when `@map` renamed
 * it, `?` for nullable, `[]` for a list, flags in brackets) and its
 * relations, in registry (declaration) order, so the same schema always
 * gives the same text and the prompt cache holds.
 *
 *     User table "users": id:Int [pk], email:String [unique], name:String?,
 *       passwordHash@password_hash:String [sensitive]; relations: posts -> Post[]
 *
 * Sensitive columns are marked `[sensitive]` (or left out with
 * `sensitiveColumns: "omit"`). See `DescribeSchemaOptions`.
 */
export function describeSchema(options: DescribeSchemaOptions = {}): string {
  const models = describeSchemaModels(options);
  const lines = models.map((model) => {
    const columns = model.columns.map(describeColumn).join(", ");
    const parts = [`${model.name} table "${model.table}": ${columns}`];
    if (model.uniques.length > 0) {
      parts.push(`unique (${model.uniques.map((key) => key.join(", ")).join("), (")})`);
    }
    if (model.relations.length > 0) {
      parts.push(`relations: ${model.relations.map(describeRelation).join(", ")}`);
    }
    return parts.join("; ");
  });
  const legend = models.some((model) => model.columns.some((column) => column.sensitive))
    ? "\nColumns marked [sensitive] hold secrets: never select them."
    : "";
  return lines.join("\n") + legend;
}

function describeColumn(column: SchemaColumnSummary): string {
  const name = column.column === column.field ? column.field : `${column.field}@${column.column}`;
  const type = (column.enum ? `${column.enum}(enum)` : column.type) + (column.list ? "[]" : "");
  const flags = [
    column.primaryKey ? "pk" : null,
    column.unique ? "unique" : null,
    column.sensitive ? "sensitive" : null,
  ].filter(Boolean);
  return `${name}:${type}${column.nullable ? "?" : ""}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`;
}

function describeRelation(relation: SchemaRelationSummary): string {
  const target = `${relation.model}${relation.kind === "many" ? "[]" : relation.nullable ? "?" : ""}`;
  if (relation.joinTable) return `${relation.name} -> ${target} via "${relation.joinTable}"`;
  if (relation.from.length > 0) {
    const on = relation.from
      .map((column, index) => `${column} = ${relation.model}.${relation.to[index] ?? "?"}`)
      .join(" and ");
    return `${relation.name} -> ${target} on ${on}`;
  }
  return `${relation.name} -> ${target}`;
}

function relationSummary(
  relation: RelationSchema,
  columnOf: (name: string) => string,
  schemas: readonly ModelSchema[],
): SchemaRelationSummary {
  const target = schemas.find((schema) => schema.name === relation.model);
  return {
    name: relation.name,
    model: relation.model,
    kind: relation.kind,
    nullable: relation.nullable,
    from: relation.from.map(columnOf),
    to: relation.to.map((name) => target?.fields[name]?.column ?? name),
    ...(relation.joinTable ? { joinTable: relation.joinTable.table } : {}),
  };
}

function isModelSchema(value: unknown): value is ModelSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ModelSchema).name === "string" &&
    typeof (value as ModelSchema).table === "string" &&
    typeof (value as ModelSchema).fields === "object" &&
    typeof (value as ModelSchema).relations === "object"
  );
}

function schemasFrom(given: DescribeSchemaOptions["schemas"]): ModelSchema[] {
  if (given !== undefined) {
    const values = Array.isArray(given) ? given : Object.values(given);
    return values.filter(isModelSchema);
  }
  // A model can be registered under more than one name; describe it once.
  const seen = new Set<string>();
  const schemas: ModelSchema[] = [];
  for (const name of registry.registeredNames()) {
    const schema = registry.get<{ $schema?: ModelSchema }>(name).$schema;
    if (!schema || seen.has(schema.name)) continue;
    seen.add(schema.name);
    schemas.push(schema);
  }
  return schemas;
}
