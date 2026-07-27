import type { DefaultSpec, FieldSchema } from "./schema";

/**
 * The values gemi supplies itself on a write, rather than leaving to the
 * database.
 *
 * Which defaults have to be client-side is not a style question — it is forced
 * by the DDL Prisma emits. Reading the template's own migration:
 *
 * ```sql
 * "publicId"  TEXT     NOT NULL,                            -- @default(cuid())
 * "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- @default(now())
 * "updatedAt" DATETIME NOT NULL,                            -- @updatedAt
 * ```
 *
 * - `publicId` and `updatedAt` carry **no database default at all**. Prisma
 *   generates them in the client, so a row inserted without them violates a
 *   NOT NULL constraint. Missing `@updatedAt` on *create* is the quiet version
 *   of this bug: the column is only nullable on models where Prisma made it so.
 * - `createdAt` does have a default, but it is `CURRENT_TIMESTAMP`, which SQLite
 *   stores as the *text* `YYYY-MM-DD HH:MM:SS` — while Prisma stores a DateTime
 *   as integer milliseconds. Letting the database fill it would write a
 *   different storage form than Prisma writes, and drop sub-second precision.
 *
 * `autoincrement()` and `dbgenerated(...)` stay with the database, which is the
 * whole of the other side of this split.
 *
 * Verified against Prisma 6.19.2 rather than assumed: a `create` there returns
 * `createdAt` and `updatedAt` as the *same instant*, which is why `now` is
 * resolved once per logical operation and passed in rather than read per field.
 */

/** Whether gemi supplies this default, or leaves the column to the database. */
export function isClientSideDefault(spec: DefaultSpec): boolean {
  return spec.kind !== "autoincrement" && spec.kind !== "dbgenerated";
}

/**
 * A field gemi must supply a value for when the caller did not: either it has a
 * client-side default, or it is `@updatedAt`, which Prisma sets on create as
 * well as on update.
 */
export function hasClientSideValue(field: FieldSchema): boolean {
  if (field.isUpdatedAt) return true;
  return field.default !== undefined && isClientSideDefault(field.default);
}

/**
 * The value for one field on one row. `now` is shared across every field and
 * every row of a single operation; everything else is generated per call.
 */
export function clientSideValue(field: FieldSchema, now: Date): unknown {
  // `@updatedAt` wins over any `@default`: Prisma stamps it on every write,
  // which is the entire point of the attribute.
  if (field.isUpdatedAt) return now;

  const spec = field.default;
  if (!spec) return undefined;

  switch (spec.kind) {
    case "cuid":
      return createCuid();
    case "uuid":
      return crypto.randomUUID();
    case "now":
      return now;
    case "value":
      return spec.value;
    default:
      // autoincrement / dbgenerated — the database's business.
      return undefined;
  }
}

// --- cuid v1 ---------------------------------------------------------------

// The format Prisma 6.19.2 actually emits for `@default(cuid())`, read off real
// rows rather than taken from the docs:
//
//   cms3j09fa0000a0452l77tbma
//   c  ms3j09fa  0000     a045         2l77tbma
//   ^  ^         ^        ^            ^
//   |  |         |        fingerprint  random
//   |  |         counter
//   |  timestamp, base 36
//   literal 'c'
//
// 25 characters, lowercase alphanumeric. Prisma's `cuid()` is still v1; `cuid2`
// is a separate, opt-in generator with a different shape, so matching v1 is what
// keeps a gemi-written `publicId` indistinguishable from a Prisma-written one in
// length, prefix and charset.

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = 36;
const BLOCK_SIZE = 4;
const DISCRETE_VALUES = BASE ** BLOCK_SIZE;

/**
 * Monotonic within a process, rolling over at one block's worth of values. It
 * is what keeps two cuids minted in the same millisecond distinct, so it must
 * not be reset or made per-call.
 */
let counter = 0;

function pad(text: string, size: number): string {
  return text.length >= size ? text : "0".repeat(size - text.length) + text;
}

/**
 * cuid v1 derives this from the process id and the hostname, to keep two
 * processes minting concurrently from colliding.
 *
 * gemi uses a random block generated once per process instead. It fills exactly
 * the same role with strictly better collision behaviour — containers routinely
 * share both a hostname and a low pid — and it keeps `node:os` off the ORM
 * runtime's import graph. Nothing observable changes: the fingerprint is four
 * characters of the same alphabet in the same position, and nothing parses it.
 */
const FINGERPRINT = randomBlock();

function randomBlock(): string {
  const bytes = new Uint8Array(BLOCK_SIZE);
  crypto.getRandomValues(bytes);

  let out = "";
  for (let i = 0; i < BLOCK_SIZE; i++) {
    let byte = bytes[i];
    // 256 is not a multiple of 36 — it is 7*36 + 4 — so taking the remainder of
    // every byte would make the first four symbols of the alphabet slightly
    // likelier than the rest. Resampling the 252-255 tail removes the bias.
    while (byte >= 252) {
      const resample = new Uint8Array(1);
      crypto.getRandomValues(resample);
      byte = resample[0];
    }
    out += ALPHABET[byte % BASE];
  }
  return out;
}

export function createCuid(): string {
  const timestamp = Date.now().toString(BASE);
  const count = pad((counter++ % DISCRETE_VALUES).toString(BASE), BLOCK_SIZE);
  return `c${timestamp}${count}${FINGERPRINT}${randomBlock()}${randomBlock()}`;
}
