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
 *   `@default(nanoid())` is the same column with a different generator on it,
 *   and was on the wrong side of this split until #350 — classified
 *   `dbgenerated`, so the ORM omitted the column and the driver rejected the
 *   row. `cuid()`, `uuid()` and `nanoid()` are Prisma's three client-side id
 *   functions and all three belong here.
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
    case "nanoid":
      // The generator always records the length, so the fallback is for an
      // artifact generated before #350 — which cannot carry `kind: "nanoid"` at
      // all — and for a hand-written spec. 21 is what `nanoid()` means.
      return createNanoid(spec.length ?? NANOID_DEFAULT_LENGTH);
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

// --- nanoid ----------------------------------------------------------------

/**
 * The alphabet, verbatim from the `nanoid` package Prisma bundles. Its order is
 * not alphabetical and not arbitrary — it is what the library ships, and an id
 * is a uniform draw from it, so a reordering changes nothing observable. It is
 * copied exactly anyway, because "the same alphabet" is the property, and a
 * character silently added or dropped would change the width of the mask below
 * from unbiased to not.
 *
 * 64 characters, which is the whole reason `& 63` is correct where cuid's
 * `% 36` needed a resample loop: every byte maps to exactly one symbol and
 * 256 is four whole alphabets, so there is no tail to reject.
 */
const NANOID_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** What `@default(nanoid())` means when written without an argument. */
const NANOID_DEFAULT_LENGTH = 21;

/**
 * The id `@default(nanoid(size))` produces in the Prisma client, generated here
 * instead — same alphabet, same mask, same length, so a gemi-written column and
 * a Prisma-written one are indistinguishable.
 *
 * Unlike a cuid there is no structure to match: a nanoid is `size` independent
 * symbols and nothing more. No timestamp, no counter, no fingerprint — which is
 * also why none of the collision reasoning around `createCuid` applies here.
 * Uniformity is the only property, and `& 63` over a 64-symbol alphabet is what
 * gives it.
 */
export function createNanoid(size: number = NANOID_DEFAULT_LENGTH): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);

  let id = "";
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET[bytes[i] & 63];
  }
  return id;
}
