import type { SqlDialect } from "./dialect";
import type { FieldSchema } from "./schema";

/**
 * Turns driver rows into the POJOs the caller sees. Built once per compiled
 * plan and closed over a fixed column list, so the hot loop does no per-row
 * schema lookups, no `for...in`, and no per-value type dispatch beyond the one
 * boolean decided at build time.
 *
 * This is a plain function today. `Model.$shape` is the static that calls it
 * (invariant 3), which is the seam a future `ActiveRecordModel` overrides to
 * build instances instead, and the seam iteration 8 hangs row provenance on.
 */
export type RowShaper = (rows: unknown[]) => Record<string, unknown>[];

interface ShapedColumn {
  /** Key on the returned object — the Prisma field name. */
  key: string;
  /** Key on the driver row — the database column name. */
  column: string;
  field: FieldSchema;
  decode: boolean;
}

/**
 * One relation the plan will load. The shaper does not fetch anything; it
 * writes the *empty* value so the key exists on every row before the relation
 * loader fills in the rows that have children.
 *
 * These three lines are where most divergence bugs live, so they are stated
 * once, here: a to-one with no match is `null` — not `undefined`, not a missing
 * key — and an empty to-many is `[]` — not `null`, not absent. Prisma returns
 * exactly that, and the differential harness compares key presence.
 */
export interface ShapedRelation {
  key: string;
  kind: "one" | "many";
}

export function buildRowShaper(
  fields: FieldSchema[],
  dialect: SqlDialect,
  relations: readonly ShapedRelation[] = [],
): RowShaper {
  const columns: ShapedColumn[] = fields.map((field) => ({
    key: field.name,
    column: field.column,
    field,
    decode: dialect.needsDecode(field),
  }));
  const width = columns.length;

  // Flattened to `(key, many)` pairs at build time for the same reason the
  // columns are: the per-row loop does no property lookups it can avoid, and
  // the common case — no relations — costs one comparison against zero.
  const related = relations.map((relation) => ({
    key: relation.key,
    many: relation.kind === "many",
  }));
  const relatedCount = related.length;

  return (rows: unknown[]) => {
    // Grown by `push` rather than preallocated: `new Array(n)` produces a holey
    // array, which is the slower of the two to write into.
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, unknown>;
      const shaped: Record<string, unknown> = {};
      for (let j = 0; j < width; j++) {
        const column = columns[j];
        const value = row[column.column];
        shaped[column.key] = column.decode
          ? dialect.decode(value, column.field)
          : (value ?? null);
      }
      for (let j = 0; j < relatedCount; j++) {
        // A fresh array per row: they are handed to the caller and pushed into
        // by the relation loader, so sharing one would alias every parent's
        // children together.
        shaped[related[j].key] = related[j].many ? [] : null;
      }
      out.push(shaped);
    }
    return out;
  };
}
