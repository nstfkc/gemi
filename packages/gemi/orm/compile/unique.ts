import { UnsupportedQueryError } from "../errors";
import type { ModelSchema } from "../schema";

/**
 * Which declared unique key a `where` names — the `@id`, a single-field
 * `@unique`, or a composite `@@unique` in Prisma's compound form
 * (`{ username_provider: { username, provider } }`).
 *
 * Shared by every operation Prisma types with a `WhereUniqueInput`: the four
 * `findUnique*` reads, and — from iteration 4 — `update`, `delete` and
 * `upsert`. Writes need the *identity* of the matched key rather than just a
 * yes, because `upsert` compiles it into an `on conflict (...)` target, so this
 * returns the group instead of asserting.
 *
 * It runs once per argument *shape*, in the compiler, never per call. The
 * alternative is a `delete` that silently removes the first of several matches.
 *
 * Note this checks that a unique key is *present*, not that nothing else is:
 * since Prisma 5 a `WhereUniqueInput` may carry extra non-unique filters
 * alongside the key, and they narrow further rather than breaking uniqueness.
 */
export function matchUniqueKey(
  schema: ModelSchema,
  where: unknown,
  op: string,
): string[] {
  const candidates = uniqueKeys(schema);

  if (typeof where !== "object" || where === null || Array.isArray(where)) {
    throw missingUnique(schema, op, candidates);
  }

  const keys = Object.keys(where as Record<string, unknown>).filter(
    (key) => (where as Record<string, unknown>)[key] !== undefined,
  );

  for (const candidate of candidates) {
    if (candidate.length === 1 && keys.includes(candidate[0])) return candidate;
    // Prisma's compound form: one key named after the fields joined by `_`.
    if (candidate.length > 1 && keys.includes(candidate.join("_"))) {
      return candidate;
    }
  }

  throw missingUnique(schema, op, candidates);
}

export function assertUniqueWhere(
  schema: ModelSchema,
  where: unknown,
  op: string,
): void {
  matchUniqueKey(schema, where, op);
}

export function uniqueKeys(schema: ModelSchema): string[][] {
  const keys: string[][] = [];
  if (schema.primaryKey.length > 0) keys.push(schema.primaryKey);
  for (const group of schema.uniques) keys.push(group);
  return keys;
}

function missingUnique(
  schema: ModelSchema,
  op: string,
  candidates: string[][],
): UnsupportedQueryError {
  const shown = candidates
    .map((group) => (group.length === 1 ? group[0] : group.join("_")))
    .join(", ");

  return new UnsupportedQueryError(
    "where",
    schema.name,
    op,
    `${op} needs a unique field. ${schema.name} declares: ${shown}. ` +
      `Use ${op === "delete" || op === "update" ? `${op}Many` : "findFirst"} ` +
      `to query on anything else.`,
  );
}
