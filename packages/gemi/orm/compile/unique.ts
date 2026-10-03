import { InvalidArgumentError, UnsupportedQueryError } from "../errors";
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
 * (`{ provider_providerId: { provider, providerId } }`).
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

  const record = where as Record<string, unknown>;

  for (const candidate of candidates) {
    if (candidate.length === 1 && keys.includes(candidate[0])) {
      assertKeyValue(schema, op, candidate[0], record[candidate[0]]);
      return candidate;
    }
    // Prisma's compound form: one key named after the fields joined by `_`.
    const compound = candidate.join("_");
    if (candidate.length > 1 && keys.includes(compound)) {
      const members = record[compound];
      if (members && typeof members === "object" && !Array.isArray(members)) {
        for (const member of candidate) {
          assertKeyValue(
            schema,
            op,
            `${compound}.${member}`,
            (members as Record<string, unknown>)[member],
          );
        }
      }
      return candidate;
    }
  }

  throw missingUnique(schema, op, candidates);
}

/**
 * Whether `value` can stand for one column of a unique key: a plain value the
 * row is matched *equal* to, never a filter.
 *
 * Primitives, a `Date`, `Bytes` (a typed array), and any class instance (a
 * `Decimal`) qualify. A plain object or an array does not — on a scalar field
 * either is read as a filter (`{ not: … }`, `{ in: […] }`, `{}`), and a filter
 * in a unique key turns "the row whose key is this" into "any row the filter
 * matches". Prisma types a unique key the same way, so nothing a Prisma caller
 * writes is refused. `null` does not qualify either: a unique column may hold
 * any number of nulls.
 *
 * The case this exists for is a request body handed to `findUnique` unchecked:
 * JSON can carry an object wherever a string was expected.
 */
export function isUniqueKeyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const type = typeof value;
  if (type !== "object") return type !== "function" && type !== "symbol";
  if (Array.isArray(value)) return false;
  if (value instanceof Date || ArrayBuffer.isView(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto !== Object.prototype && proto !== null;
}

/**
 * Refuses a unique key whose value is not a plain value — see
 * `isUniqueKeyValue`. An undefined compound member is left to
 * `compileCompoundKey`, which already names it as missing.
 */
function assertKeyValue(
  schema: ModelSchema,
  op: RefusalOrigin,
  path: string,
  value: unknown,
): void {
  if (value === undefined || isUniqueKeyValue(value)) return;
  throw new InvalidArgumentError(
    `${op.argument}.${path}`,
    op.model,
    op.operation,
    `A unique key takes a plain value to match, not ` +
      `${value === null ? "null" : Array.isArray(value) ? "an array" : "a filter object"}. ` +
      `Use findFirst/findMany (or updateMany/deleteMany) to filter on ` +
      `${schema.name}.${path.split(".").pop()}.`,
  );
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
