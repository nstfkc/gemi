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
export type JsonNullKind = "db" | "json";

const SENTINELS: Record<string, JsonNullKind> = {
  "Prisma.DbNull": "db",
  "Prisma.JsonNull": "json",
};

/**
 * Which sentinel this is, or `null` for any ordinary value.
 *
 * `Prisma.AnyNull` is deliberately absent: it means "either of the two" and is
 * only legal in a *filter*. Prisma rejects it in a write, and mapping it here
 * would quietly accept something Prisma does not.
 */
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
