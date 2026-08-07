import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  clientSideValue,
  createCuid,
  createNanoid,
  createUlid,
  createUuid,
  hasClientSideValue,
  isClientSideDefault,
} from "./defaults";
import type { DefaultKind, FieldSchema } from "./schema";

/**
 * `defaults.ts` had four exports and no test naming any of them (#258).
 *
 * `createCuid` ran — making it throw failed ten tests in `compile/write.test.ts`
 * — but exactly one assertion constrained what it produced, incidental to a
 * plan-cache test about something else:
 *
 * ```
 * expect(String(first[0])).toMatch(/^c[a-z0-9]{24}$/);
 * ```
 *
 * Prefix, charset, length. Five mutations run against the unit suite and the
 * template suite; the two the regex can see died, and three lived:
 *
 * | mutation                                         |          |
 * |--------------------------------------------------|----------|
 * | drop the `c` prefix                              | killed   |
 * | halve the random suffix                          | killed   |
 * | `counter++` becomes `0`                          | survived |
 * | fingerprint per-call rather than per-process     | survived |
 * | `byte >= 252` becomes `byte >= 256`              | survived |
 *
 * Every mutation that stayed 25 characters of lowercase alphanumeric survived
 * both suites. None of the three is a collision risk on its own — that is the
 * point. They are the layers that are there *because* the other layers are
 * probabilistic, and each could be removed without a single test changing
 * colour.
 *
 * This file is not a proposal to change `defaults.ts`. The module looks right:
 * the resample bound is correct, the counter is module-scoped, the fingerprint
 * is per-process. This is about noticing if that stops being true.
 */

// The block widths are fixed, so a cuid can be taken apart by position. Sliced
// from the *end* rather than the front, because the timestamp is the one block
// whose width is not a constant — `Date.now().toString(36)` is eight characters
// until 2059 and nine after it, and a test that would start failing on a date is
// not a test of anything here.
const RANDOM = -8;
const FINGERPRINT = -12;
const COUNTER = -16;

const fingerprintOf = (cuid: string) => cuid.slice(FINGERPRINT, RANDOM);
const randomOf = (cuid: string) => cuid.slice(RANDOM);
const counterOf = (cuid: string) =>
  Number.parseInt(cuid.slice(COUNTER, FINGERPRINT), 36);

describe("createCuid emits the shape Prisma 6.19.2 emits", () => {
  test("prefix, charset and length", () => {
    expect(createCuid()).toMatch(/^c[0-9a-z]{24}$/);
  });

  /**
   * The timestamp is the only block with a meaning outside the id, and the only
   * one that pins where the other three start. A cuid minted now decodes to now.
   */
  test("the timestamp block is base-36 milliseconds", () => {
    const before = Date.now();
    const cuid = createCuid();
    const after = Date.now();

    const timestamp = Number.parseInt(cuid.slice(1, COUNTER), 36);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

/**
 * The counter's own comment states the invariant:
 *
 * > is what keeps two cuids minted in the same millisecond distinct, so it must
 * > not be reset or made per-call.
 *
 * Nothing checked it. Freezing it at `0` does not by itself produce a collision
 * — eight characters of randomness follow it — which is exactly why no existing
 * assertion could see the difference. What it removes is the one field in the id
 * that is *not* probabilistic, silently.
 */
describe("the counter is monotonic within the process", () => {
  test("it advances by one between consecutive ids", () => {
    const counters = Array.from({ length: 5 }, () => counterOf(createCuid()));

    for (let i = 1; i < counters.length; i++) {
      expect(counters[i]).toBe(counters[i - 1] + 1);
    }
  });

  /**
   * The failure being guarded is two ids minted in the same millisecond, so mint
   * them in the same millisecond: with the clock held still the counter is the
   * only field that has to keep them apart, and it is compared on its own rather
   * than through the whole id, which the random blocks would carry regardless.
   */
  test("ids minted in one millisecond differ in the counter", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const first = createCuid();
      const second = createCuid();

      expect(first.slice(1, COUNTER)).toBe(second.slice(1, COUNTER));
      expect(counterOf(second)).toBe(counterOf(first) + 1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  /** Rolls over at one block's worth of values, so it always pads to four. */
  test("the counter block is four characters", () => {
    expect(createCuid().slice(COUNTER, FINGERPRINT)).toHaveLength(4);
  });
});

/**
 * Per-call randomness in the fingerprint's position carries the same entropy, so
 * this is not a collision risk either. What it destroys is process identity —
 * the field someone diagnosing a duplicate reads first, and the one the module
 * chose deliberately over cuid v1's pid+hostname and explains at length. Made
 * per-call it would still be four characters of the right alphabet, and it would
 * be lying.
 */
describe("the fingerprint identifies the process", () => {
  test("it is the same across every id in this process", () => {
    const fingerprints = new Set(
      Array.from({ length: 100 }, () => fingerprintOf(createCuid())),
    );

    expect(fingerprints.size).toBe(1);
  });

  /**
   * The other half: constant is not enough, it has to be *this process's*. A
   * literal would satisfy the test above forever.
   *
   * Fresh module instances stand in for fresh processes. Five of them, asserting
   * only that they are not all equal — two would be a one-in-1.68-million flake,
   * five is (1/36^4)^4, and a hardcoded fingerprint still yields exactly one
   * distinct value.
   */
  test("a fresh process gets a different one", async () => {
    const fingerprints = new Set<string>();
    for (let i = 0; i < 5; i++) {
      vi.resetModules();
      const fresh = await import("./defaults");
      fingerprints.add(fingerprintOf(fresh.createCuid()));
    }

    expect(fingerprints.size).toBeGreaterThan(1);
  });
});

/**
 * 256 is not a multiple of 36 — it is 7*36 + 4 — so `byte % 36` without the
 * resample delivers the first four symbols of the alphabet 8 times in 256 and
 * the other thirty-two 7 times in 256. That is 12.5% above uniform for `0123`,
 * and it is invisible to any assertion about a single id.
 *
 * The exact kind of loop that gets "simplified" by someone reading
 * `while (byte >= 252)` as arbitrary, which is why it is worth a frequency test.
 */
describe("the random blocks are not biased toward the low symbols", () => {
  // Two random blocks per id, four symbols each. The fingerprint is drawn from
  // the same generator but is one fixed sample, so counting it would swamp the
  // distribution with a single draw repeated 25,000 times.
  const IDS = 25_000;
  const SYMBOLS = IDS * 8;
  const BIASED = "0123";

  let counts: Map<string, number>;
  let lowShare: number;

  beforeAll(() => {
    counts = new Map();
    for (let i = 0; i < IDS; i++) {
      for (const symbol of randomOf(createCuid())) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }

    const low = [...BIASED].reduce((sum, s) => sum + (counts.get(s) ?? 0), 0);
    lowShare = low / SYMBOLS;
  });

  /**
   * Sized so it is not a flaky test rather than sized to just catch the mutant.
   * Under a uniform draw the share of `0123` is 4/36 = 0.1111 with a standard
   * deviation of 0.00031 over 200,000 symbols; the unresampled distribution sits
   * at 32/256 = 0.125, which is 44 standard deviations away. A window of ±0.004
   * is 12.7 sd of headroom in each direction and still nowhere near the mutant.
   */
  test("the four low symbols hold their uniform share", () => {
    expect(lowShare).toBeGreaterThan(4 / 36 - 0.004);
    expect(lowShare).toBeLessThan(4 / 36 + 0.004);
  });

  /** Nothing is dropped either: the resample must not truncate the alphabet. */
  test("all 36 symbols appear", () => {
    expect(counts.size).toBe(36);
  });
});

/**
 * A nanoid is `size` independent symbols and nothing else — no timestamp, no
 * counter, no fingerprint — so unlike a cuid there is no structure to take
 * apart. What is left to pin is the length, the alphabet, and that the mask
 * over that alphabet is unbiased.
 */
describe("createNanoid matches the ids the Prisma client mints", () => {
  const ALPHABET =
    "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

  /**
   * The length is the argument, and it is the whole reason `DefaultSpec` grew a
   * `length` field: `@default(nanoid(10))` and `@default(nanoid())` differ in
   * nothing else, and the column Prisma emits for either is a plain `TEXT` that
   * constrains neither.
   */
  test.each([1, 10, 21, 36])("nanoid(%i) is %i characters", (size) => {
    expect(createNanoid(size)).toHaveLength(size);
  });

  /** `nanoid()` written with no argument. */
  test("the default length is 21", () => {
    expect(createNanoid()).toHaveLength(21);
  });

  test("every character is from nanoid's url alphabet", () => {
    const symbols = new Set(
      Array.from({ length: 200 }, () => createNanoid()).join(""),
    );

    for (const symbol of symbols) expect(ALPHABET).toContain(symbol);
  });

  test("an id is minted per call", () => {
    expect(createNanoid()).not.toBe(createNanoid());
  });

  /**
   * The alphabet is 64 symbols and the mask is `& 63`, so 256 is exactly four
   * whole alphabets and every byte maps to one symbol with no tail to reject —
   * which is why this needs none of `randomBlock`'s resample loop, and why
   * "unbiased" is worth asserting rather than assumed.
   *
   * Sized against flake rather than against the mutant: 64,000 symbols puts the
   * expected count per symbol at 1000 with a standard deviation of 31.4, and a
   * ±20% window is over six sd in each direction. A mask that truncated or
   * doubled part of the alphabet lands far outside it — `& 31` would leave 32
   * symbols at zero.
   */
  test("the alphabet is drawn uniformly", () => {
    const counts = new Map<string, number>();
    for (const symbol of Array.from({ length: 1000 }, () =>
      createNanoid(64),
    ).join("")) {
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }

    expect(counts.size).toBe(64);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});

/**
 * A ULID is a timestamp and then randomness, and the ordering is the property:
 * base 32 preserves byte order, so sorting ULIDs as strings sorts them by the
 * moment they were minted. That is the part a naive `toString(32)` would break,
 * so it is the part worth pinning.
 */
describe("createUlid matches the ids the Prisma client mints", () => {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  test("26 characters of Crockford base 32", () => {
    const ulid = createUlid();

    expect(ulid).toHaveLength(26);
    for (const symbol of ulid) expect(ALPHABET).toContain(symbol);
  });

  /** `I`, `L`, `O` and `U` are the four Crockford leaves out. */
  test("it never emits the ambiguous letters", () => {
    const ids = Array.from({ length: 200 }, () => createUlid()).join("");

    expect(ids).not.toMatch(/[ILOU]/);
  });

  /**
   * The whole point of the format. Two ULIDs a millisecond apart must compare
   * in that order as plain strings — which is what fails if the timestamp is
   * rendered with a variable width, because then the fields stop lining up.
   */
  test("ids sort lexicographically by the time they were minted", () => {
    const early = createUlid(1_700_000_000_000);
    const late = createUlid(1_700_000_000_001);
    const muchLater = createUlid(1_900_000_000_000);

    expect(early < late).toBe(true);
    expect(late < muchLater).toBe(true);
  });

  /** The first ten characters are the clock, so they are shared at one instant. */
  test("the timestamp block is the first ten characters", () => {
    const at = 1_700_000_000_000;

    expect(createUlid(at).slice(0, 10)).toBe(createUlid(at).slice(0, 10));
    // ...and the remaining sixteen are not, or the id would be a constant.
    expect(createUlid(at).slice(10)).not.toBe(createUlid(at).slice(10));
  });
});

/**
 * v4 and v7 are both UUIDs on the wire and only one of them is time-ordered, so
 * every field that distinguishes them is invisible in the rendered string. That
 * is exactly why they are asserted rather than eyeballed.
 */
describe("createUuid honours the version the schema asked for", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([89ab])[0-9a-f]{3}-[0-9a-f]{12}$/;

  test("the default is v4", () => {
    expect(createUuid()).toMatch(UUID);
    expect(createUuid().match(UUID)![1]).toBe("4");
  });

  test("v7 sets the version nibble and the variant", () => {
    const match = createUuid(7).match(UUID);

    expect(match).not.toBeNull();
    expect(match![1]).toBe("7");
    // RFC 9562's variant is the two high bits `10`, which renders as 8, 9, a
    // or b in the first character of the fourth group.
    expect("89ab").toContain(match![2]);
  });

  /**
   * The reason a schema writes `uuid(7)`: the first 48 bits are big-endian
   * milliseconds, so v7s sort by creation time and land beside each other in a
   * B-tree. Minting a v4 loses that silently, which is what gemi did.
   */
  test("v7 embeds the current time, big-endian, in the first 48 bits", () => {
    const before = Date.now();
    const uuid = createUuid(7);
    const after = Date.now();

    const stamp = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);

    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  /**
   * The ordering v7 actually guarantees is **per millisecond**, not per call:
   * inside one millisecond the 74 bits after the timestamp are random, so two
   * ids minted together have no defined order. RFC 9562 offers a monotonic
   * counter for that case as an option, and neither Prisma's generator nor this
   * one takes it.
   *
   * Worth pinning at the granularity that is real rather than the one that
   * sounds better — the first version of this test minted 20 ids in a loop,
   * which all landed in the same millisecond and compared in random order.
   */
  test("v7s from different milliseconds compare in time order", () => {
    const at = 1_700_000_000_000;
    const ids = Array.from({ length: 20 }, (_, i) => {
      vi.spyOn(Date, "now").mockReturnValue(at + i);
      return createUuid(7);
    });
    vi.restoreAllMocks();

    expect([...ids].sort()).toEqual(ids);
  });

  test("an id is minted per call", () => {
    expect(createUuid(7)).not.toBe(createUuid(7));
    expect(createUuid(4)).not.toBe(createUuid(4));
  });
});

/**
 * `autoincrement()` and `dbgenerated(...)` stay with the database; everything
 * else gemi supplies. Written as an exhaustive record so that adding a
 * `DefaultKind` without deciding which side of the split it falls on is a type
 * error rather than an untested branch.
 *
 * `nanoid` and `ulid` are the kinds that arrived by getting this wrong (#350
 * and its review): neither was a `DefaultKind` at all, so both fell into
 * `dbgenerated`, and an exhaustive record cannot notice a member that does not
 * exist. What the record *does* catch is the next one, which is why the
 * predicate below is now an allowlist — a kind added to the union with no arm
 * in `clientSideValue` is answered `false` and omitted, rather than answered
 * `true` and bound as NULL.
 */
describe("isClientSideDefault splits gemi's defaults from the database's", () => {
  const expected: Record<DefaultKind, boolean> = {
    autoincrement: false,
    dbgenerated: false,
    cuid: true,
    uuid: true,
    nanoid: true,
    ulid: true,
    now: true,
    value: true,
  };

  test.each(Object.entries(expected))("%s -> %s", (kind, isClientSide) => {
    expect(isClientSideDefault({ kind: kind as DefaultKind })).toBe(
      isClientSide,
    );
  });

  /**
   * The property the allowlist exists for, and the one the denylist got wrong.
   *
   * A kind this runtime has never heard of — a newer artifact against an older
   * gemi — used to answer `true`, because it was neither `autoincrement` nor
   * `dbgenerated`. The column then joined the insert, `clientSideValue` had no
   * arm for it and returned `undefined`, and the dialect encoded that as NULL:
   * a required column fails, a nullable one silently stores NULL in every row.
   *
   * Answering `false` omits the column instead, which is the loud failure.
   */
  test("a kind this runtime does not know is left to the database", () => {
    expect(isClientSideDefault({ kind: "sequence" as DefaultKind })).toBe(false);
  });
});

const field = (over: Partial<FieldSchema> = {}): FieldSchema => ({
  name: "field",
  column: "field",
  type: "String",
  nullable: false,
  isId: false,
  isUpdatedAt: false,
  ...over,
});

describe("hasClientSideValue asks which fields gemi must fill in", () => {
  test("a client-side default", () => {
    expect(hasClientSideValue(field({ default: { kind: "cuid" } }))).toBe(true);
  });

  /**
   * The whole of #350 in one assertion: this answered `false`, so the write
   * compiler never asked for a value and left the column out of the insert.
   */
  test("a nanoid, which Prisma also fills client-side", () => {
    expect(
      hasClientSideValue(field({ default: { kind: "nanoid", length: 10 } })),
    ).toBe(true);
  });

  test("a database-side default", () => {
    expect(
      hasClientSideValue(
        field({ type: "Int", isId: true, default: { kind: "autoincrement" } }),
      ),
    ).toBe(false);
  });

  test("no default at all", () => {
    expect(hasClientSideValue(field({ nullable: true }))).toBe(false);
  });

  /**
   * `@updatedAt` carries no `@default` and no database default — Prisma sets it
   * in the client, on create as well as on update, so a row inserted without it
   * violates a NOT NULL constraint. It is the one field here that has to be
   * recognised by its attribute rather than by its default.
   */
  test("@updatedAt, which has no default", () => {
    expect(
      hasClientSideValue(field({ type: "DateTime", isUpdatedAt: true })),
    ).toBe(true);
  });
});

describe("clientSideValue produces one field's value", () => {
  const now = new Date("2024-03-01T12:00:00.000Z");

  test("cuid", () => {
    expect(
      String(clientSideValue(field({ default: { kind: "cuid" } }), now)),
    ).toMatch(/^c[0-9a-z]{24}$/);
  });

  test("uuid", () => {
    expect(
      String(clientSideValue(field({ default: { kind: "uuid" } }), now)),
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  /**
   * The bug in #350: this returned `undefined`, so `Model.create` omitted the
   * column, and Postgres rejected the row — the column Prisma's migration emits
   * for a `nanoid()` default carries no `DEFAULT` to fall back on.
   *
   * The length is asserted alongside because it is the half that fails quietly:
   * a spec that reached here without one would still produce an id, 21
   * characters of the right alphabet, and the column would just be the wrong
   * width.
   */
  test("nanoid, at the length the schema wrote", () => {
    expect(
      clientSideValue(field({ default: { kind: "nanoid", length: 10 } }), now),
    ).toHaveLength(10);
  });

  /** An artifact old enough to predate `length`, or a hand-written spec. */
  test("a nanoid with no length is 21 characters", () => {
    expect(
      clientSideValue(field({ default: { kind: "nanoid" } }), now),
    ).toHaveLength(21);
  });

  test("ulid", () => {
    expect(
      String(clientSideValue(field({ default: { kind: "ulid" } }), now)),
    ).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  /**
   * The version has to reach `createUuid`, not just sit in the artifact. A spec
   * that lost it here would hand back a v4 for a column declared `uuid(7)` —
   * still a valid UUID, no longer time-ordered, and indistinguishable by eye.
   */
  test("a uuid is minted at the version the schema wrote", () => {
    const versionOf = (value: unknown) => String(value).charAt(14);

    expect(
      versionOf(clientSideValue(field({ default: { kind: "uuid", version: 7 } }), now)),
    ).toBe("7");
    expect(
      versionOf(clientSideValue(field({ default: { kind: "uuid", version: 4 } }), now)),
    ).toBe("4");
  });

  /** An artifact old enough to predate `version`, or a hand-written spec. */
  test("a uuid with no version is v4", () => {
    expect(
      String(clientSideValue(field({ default: { kind: "uuid" } }), now)).charAt(14),
    ).toBe("4");
  });

  test.each(["cuid", "uuid", "nanoid", "ulid"] as const)(
    "a %s is minted per call",
    (kind) => {
      const one = clientSideValue(field({ default: { kind } }), now);
      const two = clientSideValue(field({ default: { kind } }), now);

      expect(one).not.toBe(two);
    },
  );

  test("a literal is passed through", () => {
    const spec = { kind: "value", value: false } as const;

    expect(
      clientSideValue(field({ type: "Boolean", default: spec }), now),
    ).toBe(false);
  });

  test.each(["autoincrement", "dbgenerated"] as const)(
    "%s is the database's business",
    (kind) => {
      expect(
        clientSideValue(field({ default: { kind } }), now),
      ).toBeUndefined();
    },
  );

  test("a field with no default and no @updatedAt", () => {
    expect(clientSideValue(field({ nullable: true }), now)).toBeUndefined();
  });

  /**
   * The comment in `defaults.ts` says so in as many words — "`@updatedAt` wins
   * over any `@default`: Prisma stamps it on every write, which is the entire
   * point of the attribute" — and nothing checked it. A field carrying both
   * would have silently taken the default's value instead.
   */
  test("@updatedAt beats a @default on the same field", () => {
    const both = field({
      type: "DateTime",
      isUpdatedAt: true,
      default: { kind: "now" },
    });

    expect(clientSideValue(both, now)).toBe(now);
  });

  test("@updatedAt beats even a @default that is not a timestamp", () => {
    const both = field({
      type: "DateTime",
      isUpdatedAt: true,
      default: { kind: "value", value: "never" },
    });

    expect(clientSideValue(both, now)).toBe(now);
  });

  /**
   * The behaviour the module header records as verified against Prisma 6.19.2
   * rather than assumed: a `create` there returns `createdAt` and `updatedAt` as
   * the *same instant*. That is why `now` is resolved once per logical operation
   * and passed in, and it was the reason with no test behind it.
   *
   * Identity, not equality — reading the clock per field would still produce
   * two dates that compare equal most of the time, and differ under load.
   */
  test("now is one instant across every field of an operation", () => {
    const createdAt = field({ type: "DateTime", default: { kind: "now" } });
    const updatedAt = field({ type: "DateTime", isUpdatedAt: true });

    expect(clientSideValue(createdAt, now)).toBe(now);
    expect(clientSideValue(updatedAt, now)).toBe(now);
    expect(clientSideValue(createdAt, now)).toBe(
      clientSideValue(updatedAt, now),
    );
  });
});
