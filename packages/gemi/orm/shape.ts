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
 *
 * There are **two implementations**, and which one runs is decided once per
 * process — see `buildRowShaper`. Iteration 7 measured the difference at 3.4× on
 * a 1000-row read, roughly a third of that whole query, and that number is the
 * only reason the second one exists.
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

/**
 * Whether this runtime allows compiling a function from source.
 *
 * Probed once, at module load, by doing it. `new Function` is unavailable under
 * a strict Content-Security-Policy and on some edge runtimes, and the failure is
 * a throw at *construction* — so asking is the only way to know, and asking once
 * is better than a try/catch per compiled plan.
 */
const CAN_COMPILE = (() => {
  try {
    return new Function("return 1")() === 1;
  } catch {
    return false;
  }
})();

let compilationEnabled = true;

/**
 * Forces the interpreted shaper.
 *
 * Exported because the two implementations must produce *identical* output, and
 * a test can only assert that if it can obtain both. That test is what stands
 * between this optimisation and a shape divergence visible only in production.
 */
export function setShaperCompilation(enabled: boolean): void {
  compilationEnabled = enabled;
}

export function shaperCompilationAvailable(): boolean {
  return CAN_COMPILE;
}

export function buildRowShaper(
  fields: FieldSchema[],
  dialect: SqlDialect,
  relations: readonly ShapedRelation[] = [],
): RowShaper {
  if (CAN_COMPILE && compilationEnabled) {
    return buildCompiledShaper(fields, dialect, relations);
  }
  return buildInterpretedShaper(fields, dialect, relations);
}

/**
 * The portable implementation: a closure over the column list, assigning keys
 * dynamically.
 *
 * Kept as the fallback rather than deleted, and not dead code — it runs wherever
 * `new Function` is refused, and it is the reference the compiled one is
 * asserted equal to.
 */
export function buildInterpretedShaper(
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

/**
 * The fast implementation: a generated function body emitting one object literal
 * with every key spelled out.
 *
 * **Why it is 3.4× faster, since the reason decides what else is worth trying.**
 * Not the property-load indirection — a variant with the column data hoisted
 * into parallel arrays measured 0% different. It is the object's *shape*:
 * `shaped[key] = value` in a loop transitions the hidden class once per
 * property, thirteen times per row on `User`, while a literal with known keys
 * gets one hidden class and one allocation. That is also why there is little
 * further to win here without changing what is returned.
 *
 * Measured on 1000 `User` rows, 13 columns: 187µs interpreted, 55µs compiled,
 * byte-identical output including key order. The comparison is committed at
 * `templates/saas-starter/app/models/bench/shaper.ts` so the claim can be
 * re-run rather than believed.
 *
 * **On generating code.** Every identifier in the emitted source comes from the
 * generated schema — field names and column names — and nothing else, which is
 * the same property that makes the SQL compiler safe. `JSON.stringify` quotes
 * them, so a name containing a quote cannot break out of the literal. This must
 * never widen to anything a caller controls: if a future feature wants a
 * caller-supplied key in the output, it belongs in the interpreted path.
 */
function buildCompiledShaper(
  fields: FieldSchema[],
  dialect: SqlDialect,
  relations: readonly ShapedRelation[],
): RowShaper {
  const parts: string[] = [];

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const key = JSON.stringify(field.name);
    const column = JSON.stringify(field.column);
    parts.push(
      dialect.needsDecode(field)
        ? `${key}: d.decode(row[${column}], f[${index}])`
        : `${key}: row[${column}] ?? null`,
    );
  }

  for (const relation of relations) {
    // Inside the literal, so every row gets its own array — the aliasing hazard
    // the interpreted path comments on is avoided by construction here.
    parts.push(
      `${JSON.stringify(relation.key)}: ${
        relation.kind === "many" ? "[]" : "null"
      }`,
    );
  }

  const source = `
    return function shape(rows) {
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        out.push({ ${parts.join(", ")} });
      }
      return out;
    };
  `;

  try {
    return new Function("d", "f", source)(dialect, fields) as RowShaper;
  } catch {
    // `CAN_COMPILE` said yes and this still failed, which would be a schema
    // shape emitting something unparseable — a bug, not an environment. Falling
    // back keeps the query working rather than failing for every caller.
    return buildInterpretedShaper(fields, dialect, relations);
  }
}
