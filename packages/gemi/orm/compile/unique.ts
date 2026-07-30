import { UnsupportedQueryError } from "../errors";
import type { ModelSchema } from "../schema";

/**
 * Where a refusal came from: the caller's model and operation, and the argument
 * path inside them.
 *
 * A triple rather than a string, because the string was doing three jobs and
 * getting two of them wrong. Nested callers passed
 * `` `${operation}.${relation.name}.${key}` `` as the *operation*, so a
 * `User.update` with a bad nested key reported
 * `(Account.update.accounts.disconnect)` — the child's model, and an operation
 * that is not one of the thirteen. `UnsupportedQueryError` documents those
 * fields as structured and inspectable; an application branching on
 * `error.operation` got something that can never match.
 *
 * Same defect #79 made `resolveLink`'s `operation` required for, and #85 was
 * filed about, one layer down. See #108.
 */
export interface RefusalOrigin {
  /** The model whose arguments these are — the *caller's*, not the child's. */
  model: string;
  /** The operation the caller wrote. */
  operation: string;
  /** The argument path, e.g. `data.accounts.disconnect.where`. */
  argument: string;
}

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
  op: RefusalOrigin,
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
  matchUniqueKey(schema, where, {
    model: schema.name,
    operation: op,
    argument: "where",
  });
}

export function uniqueKeys(schema: ModelSchema): string[][] {
  const keys: string[][] = [];
  if (schema.primaryKey.length > 0) keys.push(schema.primaryKey);
  for (const group of schema.uniques) keys.push(group);
  return keys;
}

function missingUnique(
  schema: ModelSchema,
  op: RefusalOrigin,
  candidates: string[][],
): UnsupportedQueryError {
  const shown = candidates
    // A compound key is shown in Prisma's own spelling — `tenantId_code` — so
    // the name in the message is the one the caller has to type.
    .map((group) => (group.length === 1 ? group[0] : group.join("_")))
    .join(", ");

  // The *child* is named in the message, because it is whose keys these are —
  // that half was always the useful one. What moves is which model and
  // operation the structured fields report.
  const nested = op.argument.startsWith("data.");
  const instead = nested
    ? `Name it by one of those, or reach it through the ${schema.name} model ` +
      `directly.`
    : `Use ${op.operation === "delete" || op.operation === "update" ? `${op.operation}Many` : "findFirst"} ` +
      `to query on anything else.`;

  return new UnsupportedQueryError(
    op.argument,
    op.model,
    op.operation,
    `${schema.name} needs a unique field here. It declares: ${shown}. ${instead}`,
  );
}
