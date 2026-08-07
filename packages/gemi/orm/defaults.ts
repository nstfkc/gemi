import {
  NANOID_DEFAULT_LENGTH,
  type DefaultKind,
  type DefaultSpec,
  type FieldSchema,
} from "./schema";

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
 *   row.
 *
 *   **Prisma's client registers four of these, not three.** Its generator
 *   registry reads `register("uuid") register("cuid") register("ulid")
 *   register("nanoid")`, and `prisma migrate diff` gives every one of them a
 *   `TEXT NOT NULL` with no `DEFAULT`. #350's first fix said "three" and left
 *   `ulid` falling through to `dbgenerated` — the same bug, one function over,
 *   which is what its review caught. All four are here now.
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

/**
 * The kinds gemi supplies a value for, as an allowlist.
 *
 * **It was a denylist** — `kind !== "autoincrement" && kind !== "dbgenerated"`
 * — and the difference is what a *future* kind does on a runtime that predates
 * it. A denylist says "yes, gemi supplies this" for a kind it cannot generate,
 * so the column joins the insert and `clientSideValue` hands back `undefined`,
 * which the dialect encodes as **NULL**. A nullable column then takes NULL on
 * every row, silently, where an id belonged.
 *
 * An allowlist answers "no" instead, so the column is omitted and the database
 * decides — a NOT NULL violation where it matters, and nothing where it does
 * not. `SCHEMA_ARTIFACT_VERSION` should catch that skew first; this is what
 * makes it loud if it ever does not.
 *
 * Every member must have an arm in `clientSideValue`, which the exhaustive
 * `Record<DefaultKind, boolean>` in the tests is there to hold.
 */
const CLIENT_SIDE_KINDS: ReadonlySet<DefaultKind> = new Set<DefaultKind>([
  "cuid",
  "uuid",
  "nanoid",
  "ulid",
  "now",
  "value",
]);

/** Whether gemi supplies this default, or leaves the column to the database. */
export function isClientSideDefault(spec: DefaultSpec): boolean {
  return CLIENT_SIDE_KINDS.has(spec.kind);
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
      // v1 only. `cuid(2)` is refused by the generator rather than recorded,
      // because gemi cannot reproduce `@paralleldrive/cuid2`'s output — see
      // `emit.ts`. So no artifact reaches here carrying a cuid version.
      return createCuid();
    case "uuid":
      // Absent means 4, which is what a bare `uuid()` has always meant. The
      // DMMF in fact normalises `uuid()` to `args: [4]`, so the generator
      // always records it; the fallback is for a hand-written spec.
      return createUuid(spec.version ?? 4);
    case "nanoid":
      // Likewise: the generator always records the length, so the fallback is
      // for a hand-written spec. 21 is what `nanoid()` means.
      return createNanoid(spec.length ?? NANOID_DEFAULT_LENGTH);
    case "ulid":
      return createUlid();
    case "now":
      return now;
    case "value":
      return spec.value;
    default:
      // autoincrement / dbgenerated — the database's business.
      return undefined;
  }
}

// --- random symbols --------------------------------------------------------

/**
 * `size` symbols drawn uniformly from `alphabet`.
 *
 * The one place the uniformity argument lives, because it is the same argument
 * for every id below and it used to be made twice, half in `randomBlock`'s
 * comment and half in `createNanoid`'s.
 *
 * A byte is a draw from 256, and 256 is a multiple of the alphabet's size only
 * when that size is a power of two. When it is not, `byte % size` would favour
 * the first `256 % size` symbols — for cuid's 36 that is the first four,
 * delivered 8 times in 256 against everyone else's 7, which is 12.5% above
 * uniform and invisible in any single id. `limit` cuts the tail that causes it
 * and those bytes are redrawn.
 *
 * For a 64-symbol alphabet `256 % 64` is 0, so `limit` is 256, the loop never
 * rejects, and this is exactly the `& 63` mask nanoid ships — reached by
 * arithmetic rather than by special-casing it.
 */
function randomChars(alphabet: string, size: number): string {
  const base = alphabet.length;
  const limit = 256 - (256 % base);

  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);

  let out = "";
  for (let i = 0; i < size; i++) {
    let byte = bytes[i];
    while (byte >= limit) {
      const resample = new Uint8Array(1);
      crypto.getRandomValues(resample);
      byte = resample[0];
    }
    out += alphabet[byte % base];
  }
  return out;
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

/** One four-character block of cuid's base-36 alphabet. */
function randomBlock(): string {
  return randomChars(ALPHABET, BLOCK_SIZE);
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
 * copied exactly anyway, because "the same alphabet" is the property.
 *
 * 64 characters, so `randomChars` computes a `limit` of 256 for it and never
 * rejects a byte — the same draw as nanoid's own `& 63`.
 */
const NANOID_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/**
 * The id `@default(nanoid(size))` produces in the Prisma client, generated here
 * instead — same alphabet, same length, so a gemi-written column and a
 * Prisma-written one are indistinguishable.
 *
 * Unlike a cuid there is no structure to match: a nanoid is `size` independent
 * symbols and nothing more. No timestamp, no counter, no fingerprint — which is
 * also why none of the collision reasoning around `createCuid` applies here.
 */
export function createNanoid(size: number = NANOID_DEFAULT_LENGTH): string {
  return randomChars(NANOID_ALPHABET, size);
}

// --- ulid ------------------------------------------------------------------

/**
 * Crockford's base32: the digits and the uppercase letters, less `I`, `L`, `O`
 * and `U` — the four that are misread as `1`, `1`, `0` and each other. Copied
 * from the string Prisma's client ships, which is the canonical one.
 *
 * 32 symbols, a power of two, so `randomChars` never rejects a byte here
 * either.
 */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 48 bits of milliseconds, base 32. */
const ULID_TIME_CHARS = 10;
/** 80 bits of randomness, base 32 — the width Prisma's generator uses. */
const ULID_RANDOM_CHARS = 16;

/**
 * `@default(ulid())`, which #350's first fix missed: it never had a `case`, so
 * it fell through to `dbgenerated` and the column was omitted from every insert
 * — the same bug the fix was written for, on a fourth id function.
 *
 * A ULID is a timestamp followed by randomness, and the *order* is the point:
 * the time is big-endian and base 32 preserves byte order, so sorting ULIDs
 * lexicographically sorts them by creation time. That is why the timestamp is
 * built here digit by digit rather than through `toString(32)`, which would
 * emit a variable number of characters and destroy the alignment the ordering
 * depends on.
 */
export function createUlid(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    time = ULID_ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  return time + randomChars(ULID_ALPHABET, ULID_RANDOM_CHARS);
}

// --- uuid ------------------------------------------------------------------

/**
 * `@default(uuid(v))`. Prisma's client accepts 4 and 7 and throws on anything
 * else; the generator refuses the rest before an artifact can carry it, so this
 * only ever sees those two.
 *
 * **The version is not cosmetic**, which is why it had to travel with the spec.
 * A v4 is 122 random bits. A v7 puts 48 bits of big-endian milliseconds at the
 * front, so v7s sort by creation time and land next to each other in a B-tree —
 * the entire reason a schema asks for one. Minting a v4 where the schema said 7
 * loses both properties and leaves a column that still looks like a UUID, which
 * is how it went unnoticed.
 */
export function createUuid(version: number = 4): string {
  return version === 7 ? createUuidV7() : crypto.randomUUID();
}

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/**
 * RFC 9562 §5.7: 48 bits of Unix milliseconds, the 4-bit version `7`, 12 random
 * bits, the 2-bit variant `0b10`, and 62 more random bits.
 *
 * The layout is asserted by the tests rather than trusted, because every field
 * but the timestamp is invisible in a rendered UUID.
 *
 * The ordering this buys is **per millisecond**. Everything after the timestamp
 * is random, so two ids minted in the same millisecond have no defined order
 * between them; §6.2's monotonic counter is what would fix that, and neither
 * Prisma's generator nor this one implements it. Sorting by a v7 orders rows by
 * the millisecond they were written, which is the property an index cares about.
 */
function createUuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const now = Date.now();
  // Big-endian, and `Math.floor(now / 2 ** 32)` rather than a shift: `>>>`
  // truncates to 32 bits, and the timestamp needs 48.
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = (now >>> 24) & 0xff;
  bytes[3] = (now >>> 16) & 0xff;
  bytes[4] = (now >>> 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7, keeping the random low bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 0b10, likewise

  const hex = HEX;
  return (
    hex[bytes[0]] + hex[bytes[1]] + hex[bytes[2]] + hex[bytes[3]] +
    "-" + hex[bytes[4]] + hex[bytes[5]] +
    "-" + hex[bytes[6]] + hex[bytes[7]] +
    "-" + hex[bytes[8]] + hex[bytes[9]] +
    "-" + hex[bytes[10]] + hex[bytes[11]] + hex[bytes[12]] +
      hex[bytes[13]] + hex[bytes[14]] + hex[bytes[15]]
  );
}
