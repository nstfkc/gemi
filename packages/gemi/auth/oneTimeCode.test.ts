import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const compared = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const {
  countCodeAttempt,
  foldEmail,
  hashOneTimeSecret,
  limiterKeyPart,
  normalizeEmail,
  oneTimeSecretMatches,
  randomDigits,
  resetFallbackCodeLimiter,
} = await import("./oneTimeCode");

/** One-time code primitives (#708). The routes are covered in saas-starter's `email-code.test.ts`. */

beforeEach(() => {
  vi.stubEnv("SECRET", "unit-secret");
  compared.calls = 0;
  resetFallbackCodeLimiter();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hashOneTimeSecret", () => {
  test("is keyed by SECRET, the email and the kind, and never contains the code", () => {
    const hash = hashOneTimeSecret("pin", "a@x.test", "123456");
    expect(hash).toMatch(/^h1\.[0-9a-f]{64}$/);
    expect(hash).not.toContain("123456");
    expect(hashOneTimeSecret("pin", "a@x.test", "123456")).toBe(hash);
    expect(hashOneTimeSecret("pin", "b@x.test", "123456")).not.toBe(hash);
    expect(hashOneTimeSecret("link", "a@x.test", "123456")).not.toBe(hash);

    vi.stubEnv("SECRET", "another-secret");
    expect(hashOneTimeSecret("pin", "a@x.test", "123456")).not.toBe(hash);
  });

  test("refuses to hash without a SECRET", () => {
    vi.stubEnv("SECRET", "");
    expect(() => hashOneTimeSecret("pin", "a@x.test", "1")).toThrow(/SECRET/);
  });
});

describe("oneTimeSecretMatches", () => {
  const stored = () => hashOneTimeSecret("pin", "a@x.test", "123456");

  test("matches the issued code only", () => {
    expect(oneTimeSecretMatches("pin", "a@x.test", stored(), "123456")).toBe(true);
    expect(oneTimeSecretMatches("pin", "a@x.test", stored(), "123457")).toBe(false);
    expect(oneTimeSecretMatches("pin", "b@x.test", stored(), "123456")).toBe(false);
    expect(oneTimeSecretMatches("link", "a@x.test", stored(), "123456")).toBe(false);
  });

  test("refuses what is not a string, without throwing", () => {
    for (const candidate of [undefined, null, 123456, ["123456"], {}, ""]) {
      expect(oneTimeSecretMatches("pin", "a@x.test", stored(), candidate)).toBe(false);
    }
  });

  test("every path goes through timingSafeEqual: match, mismatch, no row, odd length", () => {
    oneTimeSecretMatches("pin", "a@x.test", stored(), "123456");
    oneTimeSecretMatches("pin", "a@x.test", stored(), "000000");
    oneTimeSecretMatches("pin", "a@x.test", null, "000000");
    oneTimeSecretMatches("pin", "a@x.test", "short", "000000");
    expect(compared.calls).toBe(4);
  });

  test("a plain-text row from before hashing compares as it is", () => {
    expect(oneTimeSecretMatches("pin", "a@x.test", "135790", "135790")).toBe(true);
    expect(oneTimeSecretMatches("pin", "a@x.test", "135790", "135791")).toBe(false);
    // The hash of a code is not accepted as the code.
    expect(oneTimeSecretMatches("pin", "a@x.test", stored(), stored())).toBe(false);
  });
});

describe("randomDigits", () => {
  test("is the requested number of decimal digits", () => {
    for (const length of [4, 6, 8]) {
      expect(randomDigits(length)).toMatch(new RegExp(`^\\d{${length}}$`));
    }
  });

  test("uses every digit in every position", () => {
    const seen = Array.from({ length: 6 }, () => new Set<string>());
    for (let i = 0; i < 500; i++) {
      [...randomDigits(6)].forEach((d, p) => seen[p].add(d));
    }
    expect(seen.every((s) => s.size === 10)).toBe(true);
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  test("refuses what cannot be an address", () => {
    for (const value of [undefined, null, 1, [], "", "no-at", "a b@x.test", "@", `${"a".repeat(250)}@x.test`]) {
      expect(normalizeEmail(value)).toBeNull();
    }
  });
});

describe("foldEmail", () => {
  test("trims and lowercases, and refuses only what is not a non-empty string", () => {
    expect(foldEmail(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(foldEmail("device_id_abc")).toBe("device_id_abc");
    for (const value of [undefined, null, 1, [], "", "   "]) {
      expect(foldEmail(value)).toBeNull();
    }
  });

  test("refuses anything longer than 320 characters", () => {
    const local = "a".repeat(64);
    const atLimit = `${local}@${"b".repeat(320 - 65)}`;
    expect(foldEmail(atLimit)).toBe(atLimit);
    expect(foldEmail(`${atLimit}c`)).toBeNull();
    expect(foldEmail(`${"a".repeat(1_000_000)}@x.test`)).toBeNull();
    expect(normalizeEmail(`${"a".repeat(1_000_000)}@x.test`)).toBeNull();
  });
});

describe("limiterKeyPart", () => {
  test("keeps short parts and hashes long ones to a fixed size", () => {
    expect(limiterKeyPart("ada@example.com")).toBe("ada@example.com");
    const long = limiterKeyPart("x".repeat(100_000));
    expect(long).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(limiterKeyPart("x".repeat(100_000))).toBe(long);
    expect(limiterKeyPart("y".repeat(100_000))).not.toBe(long);
  });
});

describe("countCodeAttempt", () => {
  test("allows maxAttempts per row, then refuses; a new row starts again", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await countCodeAttempt(1, 1000, 3));
    expect(results).toEqual([true, true, true, false]);
    expect(await countCodeAttempt(2, 1000, 3)).toBe(true);
    expect(await countCodeAttempt(1, 2000, 3)).toBe(true);
  });

  test("the cap holds across a window boundary for a long-lived code", async () => {
    // A code living a day, with every guess spent just before a limiter window
    // ends: the count must not decay into a sixth guess before the code expires.
    const sixDays = 6 * 86_400_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(sixDays * 3000 - 1000);
      for (let i = 0; i < 5; i++) expect(await countCodeAttempt(7, 1, 5, 1440)).toBe(true);
      vi.setSystemTime(sixDays * 3000 + 1439 * 60_000);
      expect(await countCodeAttempt(7, 1, 5, 1440)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("emailCodeDefaults", () => {
  test("refuses settings that would break or weaken the codes", async () => {
    const { emailCodeDefaults } = await import("./config");
    expect(emailCodeDefaults().maxAttempts).toBe(5);
    expect(() => emailCodeDefaults({ maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => emailCodeDefaults({ length: 3 })).toThrow(/length/);
    expect(() => emailCodeDefaults({ expiresInMinutes: Number.NaN })).toThrow(/expiresInMinutes/);
    expect(() => emailCodeDefaults({ linkExpiresInMinutes: -1 })).toThrow(/linkExpiresInMinutes/);
  });
});
