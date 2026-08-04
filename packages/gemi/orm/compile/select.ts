import {
  InvalidArgumentError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "../errors";
import { COUNT_KEY } from "../relation-filters";
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
  const omit = args?.omit;

  // Prisma rejects using both, because the result shape would be ambiguous.
  //
  // **No current caller reaches this**, and that is deliberate rather than
  // dead. All four check it first and say it better: `plan-relations.ts:506`
  // reports `'accounts: select + include'` with the relation path, which this
  // one has no way to know. So this is the floor under a fifth caller, not a
  // duplicate to delete — the distinction #114 exists to record, and the
  // reason the test for it calls `resolveSelection` directly.
  //
  //   read.ts:206          pre-empted by read.ts:341
  //   write.ts:1277        pre-empted by write.ts:1411
  //   plan-relations.ts:660 and lateral.ts:291   by plan-relations.ts:506
  if (select !== undefined && args?.include !== undefined) {
    throw new UnsupportedQueryError(
      "select + include",
      schema.name,
      operation,
      "Prisma allows only one of them on the same query.",
    );
  }

  // ...and rejects `select` with `omit` for the same reason: one names what to
  // keep and the other what to drop, so together they describe two different
  // column lists. Verified against a generated client, which raises rather
  // than picking one.
  if (select !== undefined && omit !== undefined) {
    throw new UnsupportedQueryError(
      "select + omit",
      schema.name,
      operation,
      `'select' names what to keep and 'omit' what to drop, so the two ` +
        `describe different column lists. Prisma allows only one of them on ` +
        `the same query. Drop the 'omit' — a 'select' already excludes ` +
        `everything it does not name.`,
    );
  }

  // `include` keeps every scalar and adds relations beside them, which is
  // precisely the default column list.
  if (select === undefined || select === null) {
    return omitted(schema, omit, operation);
  }

  if (typeof select !== "object" || Array.isArray(select)) {
    throw new InvalidArgumentError(
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

    // `_count` is neither a field nor a relation. It projects a correlated
    // subquery, which `planRelationCounts` owns — including validating its own
    // shape — so here it only has to count as *something selected*, or a
    // selection of nothing but counts would be reported as empty.
    if (key === COUNT_KEY) {
      if (value !== false) relations++;
      continue;
    }

    if (!(key in schema.fields)) {
      throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
    }

    if (typeof value !== "boolean") {
      throw new InvalidArgumentError(
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

/**
 * The default column list minus whatever `omit` names.
 *
 * **The complement of `select`, and the reason to have both.** With `select`
 * the exclusion list is rewritten every time the model gains a column, and the
 * day somebody forgets is the day the new column silently stops being
 * returned. `omit: { password: true }` says the thing that is actually stable
 * about the query — *this one column must never leave the process* — so a
 * column added later is included by default, which is the safer direction for
 * everything except the field you named.
 *
 * A real projection, not a post-filter: the omitted column never enters the
 * `select` list, so it is not read, not shaped and not decoded. Prisma does the
 * same — verified from its query log, where the column is simply absent.
 *
 * Note this deliberately does *not* replace a policy's `redact`. `omit` is the
 * caller choosing; `redact` is the model refusing, and a caller cannot opt out
 * of it. See `docs/orm.md`.
 */
function omitted(
  schema: ModelSchema,
  omit: unknown,
  operation: string,
): FieldSchema[] {
  if (omit === undefined || omit === null) return Object.values(schema.fields);

  if (typeof omit !== "object" || Array.isArray(omit)) {
    throw new InvalidArgumentError(
      "omit",
      schema.name,
      operation,
      "Expected an object of fields.",
    );
  }

  const dropped = new Set<string>();

  for (const key of Object.keys(omit as Record<string, unknown>)) {
    const value = (omit as Record<string, unknown>)[key];
    if (value === undefined) continue;

    // A relation cannot be omitted — it is not a column, and it is absent
    // unless an `include` asked for it. Named separately from the unknown-field
    // case, which would send the caller looking for a typo.
    if (key in schema.relations) {
      throw new UnsupportedQueryError(
        `omit.${key}`,
        schema.name,
        operation,
        `'${key}' is a relation, not a column. A relation is already absent ` +
          `unless an 'include' asks for it.`,
      );
    }

    if (!(key in schema.fields)) {
      throw new UnknownFieldError(key, schema.name, Object.keys(schema.fields));
    }

    if (typeof value !== "boolean") {
      throw new InvalidArgumentError(
        `omit.${key}`,
        schema.name,
        operation,
        "Expected true or false.",
      );
    }

    // `false` means keep it, exactly as it does in a `select`.
    if (value) dropped.add(key);
  }

  const kept = Object.values(schema.fields).filter(
    (field) => !dropped.has(field.name),
  );

  if (kept.length === 0) {
    // Prisma raises rather than returning rows of empty objects, and a
    // `select ... from` with no columns is not valid SQL either way — the same
    // reasoning as an empty `select`.
    throw new UnsupportedQueryError(
      "omit",
      schema.name,
      operation,
      `It omits every field on ${schema.name}, which leaves no column to ` +
        `select. Prisma rejects that too.`,
    );
  }

  return kept;
}

/**
 * Adds the columns the relation planner needs to stitch on, and reports which
 * of them the caller did not ask for.
 *
 * `select: { name: true, accounts: true }` returns `{ name, accounts }` — no
 * `id` — but the accounts cannot be found without `User.id`. So it is selected,
 * shaped, used, and then deleted (see `attachRelations`). Under an `include`,
 * or a `select` that names the key itself, nothing is hidden and nothing is
 * deleted.
 *
 * Writes use it for the same reason through a different clause: a nested
 * `create` on the far side of a relation needs the parent's key before it can
 * write the child, so the `RETURNING` list has to carry that key even when the
 * caller's `select` never asked for it.
 */
export function withKeyFields(
  schema: ModelSchema,
  selection: FieldSchema[],
  keyFields: readonly string[],
): { fields: FieldSchema[]; hidden?: string[] } {
  if (keyFields.length === 0) return { fields: selection };

  const present = new Set(selection.map((field) => field.name));
  const missing = keyFields.filter((name) => !present.has(name));
  if (missing.length === 0) return { fields: selection };

  const wanted = new Set([...present, ...missing]);
  return {
    // Rebuilt in schema order rather than appended, so the emitted column list
    // depends only on *which* fields are selected and never on how they were
    // reached.
    fields: Object.values(schema.fields).filter((field) =>
      wanted.has(field.name),
    ),
    hidden: missing,
  };
}
