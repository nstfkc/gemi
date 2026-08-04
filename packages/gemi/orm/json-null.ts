/**
 * Prisma's two null sentinels for a `Json` column, recognised without importing
 * Prisma.
 *
 * A nullable `Json` column has *two* legal empty values and Prisma makes the
 * caller choose between them, because they are different rows:
 *
 *   Prisma.DbNull     the column is SQL NULL
 *   Prisma.JsonNull   the column holds the JSON value `null`
 *
 * A bare `null` is a type error on both libraries — gemi takes Prisma's
 * argument types verbatim, so the sentinels are what type-checks here too, and
 * `differential.test.ts` already notes that "a decoder that conflates them
 * returns the wrong one of two legal answers".
 *
 * Nothing translated them. Both are ordinary objects with no enumerable
 * properties, so every path that serialises a Json value turned them into the
 * jsonb object `{}` — a plausible-looking value, silently wrong, on both
 * dialects and with nothing raised. That is the same silent mis-store the
 * bare-scalar refusal existed to prevent.
 *
 * **Recognised by `toString`, not by `instanceof` or the constructor's name.**
 * The ORM runtime may not import the Prisma client package at all —
 * `runtime-isolation.test.ts` greps for the name, comments included — so
 * `instanceof` is unavailable. Prisma implements
 * `toString` on these deliberately, returning `Prisma.DbNull` and
 * `Prisma.JsonNull`; a constructor name would be the other candidate and is the
 * one a minifier is free to rewrite.
 */
export type JsonNullKind = "db" | "json" | "any";

const SENTINELS: Record<string, JsonNullKind> = {
  "Prisma.DbNull": "db",
  "Prisma.JsonNull": "json",
  "Prisma.AnyNull": "any",
};

/**
 * Which sentinel this is, or `null` for any ordinary value.
 *
 * **`"any"` is not a storable value, and the two others are.** `DbNull` and
 * `JsonNull` each name one of the column's two legal empty states, so an
 * encoder can turn either into something to write. `AnyNull` names *both at
 * once* — it is a question, only ever meaningful in a filter, and Prisma raises
 * if it reaches a write. Callers that encode must therefore handle it
 * separately rather than treating the three alike; `cast.ts` and the SQLite
 * encoder refuse it outright, since by the time a value reaches them the filter
 * and write paths have each had their say.
 *
 * It was previously absent from this table, and **absent is not the same as
 * refused** — it fell through to the data path, where a write stored it as the
 * jsonb object `{}` and a filter compiled to `= '{}'`, returning the complement
 * of the rows it asks for. That was #259.
 */
/**
 * A sentinel, built the way the recogniser below demands.
 *
 * **A class, so the prototype's `toString` is non-enumerable.** A method in an
 * object literal is enumerable, `for…in` walks it, and the shape check below
 * would reject it — which is how the first version of the test helper in
 * `json-null.test.ts` failed while Prisma's real sentinels passed. Prisma builds
 * them as classes; this matches, and `json-null.test.ts` pins that they are
 * recognised so the two cannot drift apart.
 *
 * **The tag still reads `Prisma.…`, and that is deliberate.** It is what makes
 * gemi's sentinel and Prisma's the *same value* as far as every reader is
 * concerned: an app migrating off `@prisma/client` can swap the import without
 * touching a call site, and one that still passes Prisma's keeps working. The
 * tag is a wire format shared with another library, not a name gemi is free to
 * choose.
 */
function sentinel(tag: string): object {
  return new (class {
    toString() {
      return tag;
    }
  })();
}

/**
 * Nominal types for the three sentinels.
 *
 * Branded rather than typed as `object`, so a `Json` column's input type can
 * name exactly these and nothing else. The brand is a type-level fiction — the
 * runtime values carry no such property, and must not: `jsonNullKind` rejects
 * any object with own properties, which is what stops an ordinary value from
 * being mistaken for a sentinel.
 */
declare const sentinelBrand: unique symbol;

export interface DbNullValue {
  readonly [sentinelBrand]: "db";
}
export interface JsonNullValue {
  readonly [sentinelBrand]: "json";
}
export interface AnyNullValue {
  readonly [sentinelBrand]: "any";
}

/**
 * The two empty states of a nullable `Json` column, and the filter that means
 * both.
 *
 * `docs/orm.md` used to spell these `Prisma.DbNull` and `Prisma.JsonNull`,
 * which made a *runtime* value import of `@prisma/client` the one piece of
 * ordinary application code that could not be written without the package. The
 * recogniser never needed it — it has always matched structurally, precisely so
 * that the ORM runtime could stay free of Prisma — so exporting gemi's own
 * costs nothing and removes the last such import.
 *
 * `AnyNull` is a question, not a value: it is only meaningful in a filter, and
 * both `cast.ts` and the SQLite encoder refuse it in a write.
 */
export const DbNull = sentinel("Prisma.DbNull") as DbNullValue;
export const JsonNull = sentinel("Prisma.JsonNull") as JsonNullValue;
export const AnyNull = sentinel("Prisma.AnyNull") as AnyNullValue;

/**
 * The ORM's own spelling of `JsonNull`, for a comparison the *compiler* authors
 * rather than the caller.
 *
 * `AnyNull` compiles to `is null or = <JSON null>`, and the right-hand side has
 * no argument to read it out of — the caller wrote `AnyNull`, not `JsonNull`.
 * Rather than teach the encoders a second way to say the same thing, or splice
 * a literal into the SQL text, the compiler binds this and every existing path
 * treats it exactly as it treats the real sentinel.
 *
 * The same object as the exported `JsonNull` rather than a second one: two
 * values with one tag would be two things to keep recognisable, and the
 * compiler's need and the caller's are the same need.
 */
export const JSON_NULL: object = JsonNull as unknown as object;

export function jsonNullKind(value: unknown): JsonNullKind | null {
  if (typeof value !== "object" || value === null) return null;

  // **A sentinel carries no data**, and checking that before anything else is
  // what makes this safe rather than merely usually-right.
  //
  // Recognising by `toString` alone is forgeable: an object whose `toString`
  // happens to return `Prisma.DbNull` was read as the sentinel and written as
  // SQL NULL, losing the object. It also made the bind *throw* for a value
  // whose `toString` throws — something Prisma stores without ever calling it,
  // since `JSON.stringify` does not consult `toString`.
  //
  // Both reach `String` only for an object with nothing in it, which no
  // application stores on purpose. The enumerable check runs first because it
  // allocates nothing and exits on the first key, which is the common case; the
  // own-property scan is for the handful of values that get past it, and is
  // what keeps `[]` and `{}` out — an empty array is a legitimate Json value.
  for (const _key in value) return null;
  if (Object.getOwnPropertyNames(value).length > 0) return null;

  // A null-prototype object has no `toString` at all and `String` throws on it.
  // It is a legitimate Json value, so this answers "not a sentinel" rather than
  // failing the write.
  let tag: string;
  try {
    tag = String(value);
  } catch {
    return null;
  }

  return SENTINELS[tag] ?? null;
}
