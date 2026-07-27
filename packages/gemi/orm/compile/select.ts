import { UnknownFieldError, UnsupportedQueryError } from "../errors";
import type { FieldSchema, ModelSchema } from "../schema";

/**
 * Resolves the column list a query returns.
 *
 * Prisma's default is every scalar field — but never as `select *`, because the
 * explicit list is what lets the shaper be built once from a fixed order and
 * what stops a migration from silently changing the result shape.
 *
 * This is the first place the emitted column list varies by query, which makes
 * it the first real test of the shaper: the result must contain exactly the
 * selected keys, with no extras and no `undefined` placeholders, because Prisma
 * returns exactly the selected keys and the differential harness compares key
 * sets.
 */
export function resolveSelection(
  schema: ModelSchema,
  args: any,
  operation: string,
): FieldSchema[] {
  const select = args?.select;

  // Prisma rejects using both, because the result shape would be ambiguous.
  if (select !== undefined && args?.include !== undefined) {
    throw new UnsupportedQueryError(
      "select + include",
      schema.name,
      operation,
      "Prisma allows only one of them on the same query.",
    );
  }

  // `include` keeps every scalar and adds relations beside them, which is
  // precisely the default column list.
  if (select === undefined || select === null) {
    return Object.values(schema.fields);
  }

  if (typeof select !== "object" || Array.isArray(select)) {
    throw new UnsupportedQueryError(
      "select",
      schema.name,
      operation,
      "Expected an object.",
    );
  }

  const selected: FieldSchema[] = [];

  // Schema order, not the caller's key order: two selections of the same fields
  // in different orders are one plan, so they must produce one column list.
  for (const [name, field] of Object.entries(schema.fields)) {
    const wanted = (select as Record<string, unknown>)[name];
    if (wanted === true) selected.push(field);
  }

  let relations = 0;

  // Validate everything the caller named, including the keys that were switched
  // off — a typo in a `false` entry is still a typo.
  for (const key of Object.keys(select as Record<string, unknown>)) {
    const value = (select as Record<string, unknown>)[key];
    if (value === undefined) continue;

    // A relation inside a `select` is a relation node, not a column. The
    // planner owns it, including validating its own arguments; here it only has
    // to be counted, so that a selection of nothing but relations is not
    // mistaken for an empty one.
    if (key in schema.relations) {
      if (value !== false) relations++;
      continue;
    }

    if (!(key in schema.fields)) {
      throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
    }

    if (typeof value !== "boolean") {
      throw new UnsupportedQueryError(
        `select.${key}`,
        schema.name,
        operation,
        "Expected true or false.",
      );
    }
  }

  if (selected.length === 0 && relations === 0) {
    // Prisma raises rather than returning rows of empty objects, and a
    // `select ... from` with no columns is not valid SQL either way.
    throw new UnsupportedQueryError(
      "select",
      schema.name,
      operation,
      "At least one field must be selected.",
    );
  }

  // `select: { accounts: true }` selects no scalar at all, and is legal —
  // Prisma returns `{ accounts: [...] }`. The column list is still not empty,
  // because the relation's own key column is added by the caller of this
  // function and then hidden again from the result.
  return selected;
}
