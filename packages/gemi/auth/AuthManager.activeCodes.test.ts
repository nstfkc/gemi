import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AuthManager } from "./AuthManager";
import { emailCodeDefaults, type EmailCodeConfig } from "./config";
import { resetFallbackCodeLimiter } from "./oneTimeCode";
import type { MagicLinkTokenRow } from "./types";

/**
 * `emailCode.activeCodes` (#1046): how many one-time codes an address holds at
 * once. 1 (the default) replaces the old code on every request; above 1 the
 * newest codes stay usable, using one ends them all, and guesses share one
 * budget.
 */

const EMAIL = "ada@example.com";
const MINUTE = 60_000;

class MemoryProvider {
  rows: MagicLinkTokenRow[] = [];
  nextId = 1;

  async createMagicLinkToken(args: { email: string; token: string; pin: string }) {
    // The MagicLinkToken table's @@unique([token, email]) and @@unique([pin, email]).
    for (const row of this.rows) {
      if (row.email !== args.email) continue;
      if (row.token === args.token || row.pin === args.pin) {
        throw new Error("Unique constraint failed on MagicLinkToken");
      }
    }
    const row = { id: this.nextId++, ...args, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }
  async findMagicLinkTokenByEmail(email: string) {
    return this.newest(email)[0] ?? null;
  }
  async listMagicLinkTokensByEmail(email: string, take: number) {
    return this.newest(email).slice(0, take);
  }
  async deleteMagicLinkTokensExcept(email: string, keepIds: number[]) {
    this.rows = this.rows.filter((row) => row.email !== email || keepIds.includes(row.id));
  }
  async claimMagicLinkToken(id: number) {
    // Yields first, as a database round trip would, so concurrent claims interleave.
    await Promise.resolve();
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length < before;
  }
  async deleteMagicLinkToken(email: string) {
    this.rows = this.rows.filter((row) => row.email !== email);
  }
  private newest(email: string) {
    return this.rows.filter((row) => row.email === email).sort((a, b) => b.id - a.id);
  }
}

let provider: MemoryProvider;
const previousSecret = process.env.SECRET;

function manager(emailCode: EmailCodeConfig = {}) {
  return new AuthManager({ emailCode }, provider as never);
}

beforeEach(() => {
  process.env.SECRET = "test-secret";
  resetFallbackCodeLimiter();
  provider = new MemoryProvider();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.SECRET = previousSecret;
});

describe("activeCodes: 1 (the default)", () => {
  test("a new request replaces the outstanding code, as before", async () => {
    const auth = manager();
    const list = vi.spyOn(provider, "listMagicLinkTokensByEmail");
    const first = await auth.issueOneTimeCode(EMAIL, 6);
    const second = await auth.issueOneTimeCode(EMAIL, 6);

    expect(provider.rows).toHaveLength(1);
    expect((await auth.verifyOneTimeCode(EMAIL, first.pin)).status).toBe(
      first.pin === second.pin ? "ok" : "invalid",
    );
    expect(await auth.verifyMagicLinkToken(EMAIL, first.token)).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  test("the guess past maxAttempts burns the code", async () => {
    const auth = manager({ maxAttempts: 2 });
    const { pin } = await auth.issueOneTimeCode(EMAIL, 6);
    const wrong = pin === "000000" ? "111111" : "000000";

    expect((await auth.verifyOneTimeCode(EMAIL, wrong)).status).toBe("invalid");
    expect((await auth.verifyOneTimeCode(EMAIL, wrong)).status).toBe("invalid");
    expect((await auth.verifyOneTimeCode(EMAIL, pin)).status).toBe("too_many_attempts");
    expect(provider.rows).toHaveLength(0);
  });
});

describe("activeCodes: 3", () => {
  test("keeps the last three codes working; a fourth request drops the oldest", async () => {
    const auth = manager({ activeCodes: 3 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await auth.issueOneTimeCode(EMAIL, 6));

    expect(provider.rows.map((row) => row.id)).toEqual([2, 3, 4]);
    expect(await auth.verifyMagicLinkToken(EMAIL, codes[0].token)).toBe(false);
    const result = await auth.verifyOneTimeCode(EMAIL, codes[1].pin);
    expect(result).toMatchObject({ status: "ok", row: { id: 2 } });
  });

  test("using one code invalidates the others", async () => {
    const auth = manager({ activeCodes: 3 });
    const a = await auth.issueOneTimeCode(EMAIL, 6);
    const b = await auth.issueOneTimeCode(EMAIL, 6);
    const c = await auth.issueOneTimeCode(EMAIL, 6);

    expect((await auth.verifyOneTimeCode(EMAIL, b.pin)).status).toBe("ok");
    expect(provider.rows).toHaveLength(0);
    expect((await auth.verifyOneTimeCode(EMAIL, a.pin)).status).toBe("invalid");
    expect(await auth.verifyMagicLinkToken(EMAIL, c.token)).toBe(false);
  });

  test("the link of any live code works, and using it ends them all", async () => {
    const auth = manager({ activeCodes: 3 });
    const a = await auth.issueOneTimeCode(EMAIL, 6);
    const b = await auth.issueOneTimeCode(EMAIL, 6);

    expect(await auth.verifyMagicLinkToken(EMAIL, a.token)).toBe(true);
    expect(provider.rows).toHaveLength(0);
    expect(await auth.verifyMagicLinkToken(EMAIL, b.token)).toBe(false);
  });

  test("an expired code is refused while a newer one still works", async () => {
    const auth = manager({ activeCodes: 3 });
    const old = await auth.issueOneTimeCode(EMAIL, 6);
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    const fresh = await auth.issueOneTimeCode(EMAIL, 6);

    // The old row stays for its link, which lives for days.
    expect(provider.rows).toHaveLength(2);
    if (old.pin !== fresh.pin) {
      expect((await auth.verifyOneTimeCode(EMAIL, old.pin)).status).toBe("invalid");
    }
    expect((await auth.verifyOneTimeCode(EMAIL, fresh.pin)).status).toBe("ok");
  });

  test("with every code expired the answer is expired", async () => {
    const auth = manager({ activeCodes: 3 });
    await auth.issueOneTimeCode(EMAIL, 6);
    const last = await auth.issueOneTimeCode(EMAIL, 6);
    vi.setSystemTime(Date.now() + 11 * MINUTE);

    expect((await auth.verifyOneTimeCode(EMAIL, last.pin)).status).toBe("expired");
  });

  test("a request deletes codes whose code and link have both expired", async () => {
    const auth = manager({ activeCodes: 3, linkExpiresInMinutes: 30 });
    await auth.issueOneTimeCode(EMAIL, 6);
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    await auth.issueOneTimeCode(EMAIL, 6);

    expect(provider.rows.map((row) => row.id)).toEqual([2]);
  });

  test("guesses share one budget across the live codes", async () => {
    const auth = manager({ activeCodes: 3, maxAttempts: 5 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push(await auth.issueOneTimeCode(EMAIL, 6));
    const wrong = codes.some((c) => c.pin === "000000") ? "0000000" : "000000";

    for (let i = 0; i < 5; i++) {
      expect((await auth.verifyOneTimeCode(EMAIL, wrong)).status).toBe("invalid");
    }
    expect((await auth.verifyOneTimeCode(EMAIL, codes[2].pin)).status).toBe("too_many_attempts");
    expect(provider.rows).toHaveLength(0);
  });

  test("a new code does not refill the budget of the codes it joins", async () => {
    const auth = manager({ activeCodes: 3, maxAttempts: 5 });
    const a = await auth.issueOneTimeCode(EMAIL, 6);
    const wrong = "0000000";
    for (let i = 0; i < 4; i++) await auth.verifyOneTimeCode(EMAIL, wrong);
    const b = await auth.issueOneTimeCode(EMAIL, 6);

    // `a` has one guess left, and every guess counts against it too.
    expect((await auth.verifyOneTimeCode(EMAIL, wrong)).status).toBe("invalid");
    expect((await auth.verifyOneTimeCode(EMAIL, b.pin)).status).toBe("too_many_attempts");
    expect((await auth.verifyOneTimeCode(EMAIL, a.pin)).status).toBe("invalid");
  });

  test("two requests with the same code: only one signs in", async () => {
    const auth = manager({ activeCodes: 3 });
    await auth.issueOneTimeCode(EMAIL, 6);
    const b = await auth.issueOneTimeCode(EMAIL, 6);

    const results = await Promise.all([
      auth.verifyOneTimeCode(EMAIL, b.pin),
      auth.verifyOneTimeCode(EMAIL, b.pin),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["invalid", "ok"]);
    expect(provider.rows).toHaveLength(0);
  });

  test("claim: false leaves the codes for claimOneTimeCode, which ends them all", async () => {
    const auth = manager({ activeCodes: 3 });
    const a = await auth.issueOneTimeCode(EMAIL, 6);
    await auth.issueOneTimeCode(EMAIL, 6);

    const result = await auth.verifyOneTimeCode(EMAIL, a.pin, { claim: false });
    expect(result.status).toBe("ok");
    expect(provider.rows).toHaveLength(2);
    if (result.status !== "ok") return;

    expect(await auth.claimOneTimeCode(EMAIL, result.row.id)).toBe(true);
    expect(provider.rows).toHaveLength(0);
    expect(await auth.claimOneTimeCode(EMAIL, result.row.id)).toBe(false);
  });
});

describe("a fixed or repeated code (#1046 follow-up)", () => {
  test("two requests with a fixed generateCode: the second succeeds and the code works", async () => {
    const auth = new AuthManager(
      { emailCode: { activeCodes: 3 }, generateCode: () => "424242" },
      provider as never,
    );
    const first = await auth.issueOneTimeCode(EMAIL, 6);
    const second = await auth.issueOneTimeCode(EMAIL, 6);

    expect(first.pin).toBe("424242");
    expect(second.pin).toBe("424242");
    // The older row with the same code is replaced by the newer one.
    expect(provider.rows.map((row) => row.id)).toEqual([2]);
    expect(await auth.verifyMagicLinkToken(EMAIL, first.token)).toBe(false);
    expect((await auth.verifyOneTimeCode(EMAIL, "424242")).status).toBe("ok");
    expect(provider.rows).toHaveLength(0);
  });

  test("a fixed code keeps one row however often it is requested", async () => {
    const auth = new AuthManager(
      { emailCode: { activeCodes: 3 }, generateCode: () => "424242" },
      provider as never,
    );
    for (let i = 0; i < 5; i++) await auth.issueOneTimeCode(EMAIL, 6);

    expect(provider.rows.map((row) => row.id)).toEqual([5]);
    expect((await auth.verifyOneTimeCode(EMAIL, "424242")).status).toBe("ok");
  });

  test("a random code that repeats a kept one replaces only that one", async () => {
    const pins = ["111111", "222222", "111111"];
    const auth = new AuthManager(
      { emailCode: { activeCodes: 3 }, generateCode: () => pins.shift() },
      provider as never,
    );
    const a = await auth.issueOneTimeCode(EMAIL, 6);
    const b = await auth.issueOneTimeCode(EMAIL, 6);
    const c = await auth.issueOneTimeCode(EMAIL, 6);

    expect(provider.rows.map((row) => row.id).sort()).toEqual([2, 3]);
    expect(await auth.verifyMagicLinkToken(EMAIL, a.token)).toBe(false);
    expect((await auth.verifyOneTimeCode(EMAIL, b.pin, { claim: false })).status).toBe("ok");
    const result = await auth.verifyOneTimeCode(EMAIL, c.pin);
    expect(result).toMatchObject({ status: "ok", row: { id: 3 } });
  });

  test("a fixed magic-link token is replaced the same way", async () => {
    const auth = new AuthManager(
      {
        emailCode: { activeCodes: 3 },
        generateMagicLinkToken: () => "fixed-token",
      },
      provider as never,
    );
    await auth.issueOneTimeCode(EMAIL, 6);
    const second = await auth.issueOneTimeCode(EMAIL, 6);

    expect(provider.rows.map((row) => row.id)).toEqual([2]);
    expect((await auth.verifyOneTimeCode(EMAIL, second.pin, { claim: false })).status).toBe("ok");
    expect(await auth.verifyMagicLinkToken(EMAIL, "fixed-token")).toBe(true);
  });

  test("activeCodes: 1 with a fixed code still replaces the row", async () => {
    const auth = new AuthManager(
      { emailCode: {}, generateCode: () => "424242" },
      provider as never,
    );
    await auth.issueOneTimeCode(EMAIL, 6);
    await auth.issueOneTimeCode(EMAIL, 6);

    expect(provider.rows.map((row) => row.id)).toEqual([2]);
    expect((await auth.verifyOneTimeCode(EMAIL, "424242")).status).toBe("ok");
  });
});

test("activeCodes must be an integer from 1 to 5", () => {
  for (const activeCodes of [0, 6, 1.5]) {
    expect(() => emailCodeDefaults({ activeCodes })).toThrow(
      `auth.emailCode.activeCodes must be an integer from 1 to 5, got ${activeCodes}`,
    );
  }
  expect(emailCodeDefaults().activeCodes).toBe(1);
  expect(emailCodeDefaults({ activeCodes: 5 }).activeCodes).toBe(5);
});
