import { UnsupportedQueryError } from "./errors";
import type { ModelSchema } from "./schema";

/**
 * Row provenance: where a returned object came from, and what it looked like
 * when it arrived.
 *
 * This is the whole of invariant 5, and the reason it is opt-in. Queries return
 * plain objects — no proxies, no conditional return types, no signature that
 * changes depending on a flag — so `save(row)` needs somewhere *outside* the row
 * to remember which model and which primary key it belongs to. A `WeakMap` keyed
 * on the object is that somewhere, and it is the only shape that does not leak:
 * the entry goes when the row does.
 *
 * **The cost of that choice, stated up front because it is the first thing
 * anyone will hit.** Provenance is attached to an object *identity*. A row that
 * is spread (`{ ...user }`), cloned, or round-tripped through JSON is a
 * different object and has none. `save` raises in that case rather than
 * guessing, because the guess would be "write every column", and writing a
 * column the caller never fetched is how a partial select silently reverts data.
 *
 * Off by default. Iteration 7 measured shaping at ~55µs per 1000 rows, and a
 * WeakMap insert plus a snapshot clone per row is a real fraction of that — so
 * the default path must not pay for a feature most queries do not use.
 */

export interface Provenance {
  /** The model name, so `save` compiles against the right schema. */
  model: string;
  /** The primary key values, captured at fetch time so a mutation cannot move the row. */
  key: Record<string, unknown>;
  /**
   * The values as fetched, for the columns that were fetched.
   *
   * Only those columns: a partially selected row can still be saved, it just
   * cannot write what it never read. That is the correct behaviour rather than a
   * limitation — the alternative is writing a default over a column that holds
   * something else.
   */
  snapshot: Record<string, unknown>;
}

const provenance = new WeakMap<object, Provenance>();

/**
 * Records provenance for a shaped row.
 *
 * Called only when the caller asked for it. The snapshot is a shallow copy of
 * the row's own scalar keys — shallow because a deep clone would have to decide
 * what to do with a `Json` column's nested object, and the dirty check compares
 * with `!==`, so a caller who mutates a nested object *in place* has changed
 * something this cannot see. That is documented rather than solved: solving it
 * means structural comparison per row per field, which is exactly the per-row
 * cost this feature is trying to keep off the default path.
 */
export function track(
  row: object,
  schema: ModelSchema,
  relationKeys: readonly string[],
): void {
  const snapshot: Record<string, unknown> = {};
  const key: Record<string, unknown> = {};
  const source = row as Record<string, unknown>;
  const skip = new Set(relationKeys);

  for (const name of Object.keys(source)) {
    // Relations are not this row's columns to write, and an attached child array
    // in a snapshot would make every `save` look dirty.
    if (skip.has(name)) continue;
    if (!(name in schema.fields)) continue;
    snapshot[name] = source[name];
  }

  for (const name of schema.primaryKey) {
    key[name] = source[name];
  }

  provenance.set(row, { model: schema.name, key, snapshot });
}

export function provenanceOf(row: unknown): Provenance | undefined {
  if (row === null || typeof row !== "object") return undefined;
  return provenance.get(row);
}

/**
 * The columns whose value differs from the snapshot.
 *
 * Compared with `!==`, which is right for the scalars an encoder produces and
 * wrong for a `Date` — two Dates for the same instant are different objects. So
 * `Date` is compared by instant and typed arrays byte-wise, the same three cases
 * `sameEncoded` in the write compiler handles, and for the same reason: without
 * it, every save of a row carrying a timestamp would rewrite that timestamp.
 */
export function changedFields(row: object): Record<string, unknown> {
  const record = provenanceOf(row);
  if (!record) return {};

  const source = row as Record<string, unknown>;
  const changed: Record<string, unknown> = {};

  for (const name of Object.keys(record.snapshot)) {
    if (!same(source[name], record.snapshot[name])) {
      changed[name] = source[name];
    }
  }

  return changed;
}

/** Replaces the snapshot after a successful save, so a second save is a no-op. */
export function resnapshot(row: object, written: Record<string, unknown>): void {
  const record = provenanceOf(row);
  if (!record) return;

  for (const name of Object.keys(written)) {
    record.snapshot[name] = written[name];
  }
}

/**
 * Raised when `save` is handed something it cannot place.
 *
 * Separate from a generic error because the two causes have different fixes and
 * both are easy to hit: the query did not ask for tracking, or the object is a
 * copy of one that did.
 */
export function untracked(row: unknown, model: string): UnsupportedQueryError {
  const shape =
    row === null || row === undefined
      ? String(row)
      : Array.isArray(row)
        ? "an array"
        : typeof row;

  return new UnsupportedQueryError(
    "save",
    model,
    "save",
    `This object carries no provenance, so there is no row to update. Either ` +
      `the query did not ask for it — pass { track: true } as the second ` +
      `argument, e.g. ${model}.findUnique({ where }, { track: true }) — or this ` +
      `is a copy of a row that did. Provenance is keyed on object identity, so ` +
      `spreading, cloning or JSON round-tripping a row loses it. ` +
      `(Received ${shape}.)`,
  );
}

/** Test-only: provenance is a module-level WeakMap, and a test may need it empty. */
export function isTracked(row: unknown): boolean {
  return provenanceOf(row) !== undefined;
}

/**
 * Value equality for the dirty check. See `changedFields` for why it is not
 * `!==`.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  return false;
}
