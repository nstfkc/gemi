import { createHmac } from "crypto";
import { describe, expect, test } from "vitest";
import {
  canonicalize,
  consumePendingCall,
  readSignature,
  signPendingCall,
  verifyPendingCall,
  type PendingCallClaims,
} from "./signing";

const secret = "signing-test-secret";

function claims(overrides: Partial<PendingCallClaims> = {}): PendingCallClaims {
  return {
    runId: "run_1",
    toolCallId: "call_1",
    name: "refundOrder",
    kind: "approval",
    input: { orderId: "ord_1", amountCents: 4200 },
    ...overrides,
  };
}

describe("canonicalize", () => {
  test("is insensitive to key order, so a round trip does not invalidate an approval", () => {
    expect(canonicalize({ a: 1, b: [{ y: 2, x: 1 }] })).toBe(
      canonicalize({ b: [{ x: 1, y: 2 }], a: 1 }),
    );
  });

  test("keeps array order, where order is the value", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  test("drops undefined members, which do not survive JSON anyway", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe("a signed pending call", () => {
  test("verifies against the claims it was made from", () => {
    const signature = signPendingCall(claims(), { secret });
    const result = verifyPendingCall(signature, claims(), { secret });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.runId).toBe("run_1");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  test("survives an input that was parsed and re-serialized on the way back", () => {
    const signature = signPendingCall(claims(), { secret });
    const roundTripped = JSON.parse(
      JSON.stringify({ amountCents: 4200, orderId: "ord_1" }),
    );
    expect(verifyPendingCall(signature, claims({ input: roundTripped }), { secret }).ok).toBe(
      true,
    );
  });

  test("carries the issuing run in the clear, because the answer arrives in a later run", () => {
    const signature = signPendingCall(claims(), { secret });
    expect(readSignature(signature)?.runId).toBe("run_1");
  });

  test("rejects an input rewritten on the way back", () => {
    const signature = signPendingCall(claims(), { secret });
    const result = verifyPendingCall(
      signature,
      claims({ input: { orderId: "ord_1", amountCents: 999_999 } }),
      { secret },
    );
    expect(result).toEqual({ ok: false, reason: "forged" });
  });

  test("rejects an approval's signature reused to supply an output", () => {
    // The attack the `kind` claim exists for: an approval is a tool the server
    // runs, so a client handing back its output would be fabricating a result.
    const signature = signPendingCall(claims(), { secret });
    expect(verifyPendingCall(signature, claims({ kind: "client" }), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("covers the run it was issued for, so a token cannot be re-pointed", () => {
    // Note what this does *not* say. `Agent` reads the runId out of the token
    // rather than choosing it, so this is the MAC covering the field, not a
    // replay defence — replay is `consumePendingCall` below, and the end-to-end
    // case is in Agent.test.ts.
    const signature = signPendingCall(claims(), { secret });
    expect(verifyPendingCall(signature, claims({ runId: "run_2" }), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("rejects a signature moved onto a different call of the same tool", () => {
    const signature = signPendingCall(claims(), { secret });
    expect(verifyPendingCall(signature, claims({ toolCallId: "call_2" }), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("rejects one signed with another key", () => {
    const signature = signPendingCall(claims(), { secret: "someone else's key" });
    expect(verifyPendingCall(signature, claims(), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("reports expiry separately, because it is a sentence to show and not an alert", () => {
    const now = Date.now();
    const signature = signPendingCall(claims(), { secret, ttlMs: 1000, now });
    expect(verifyPendingCall(signature, claims(), { secret, now: now + 500 }).ok).toBe(true);
    expect(verifyPendingCall(signature, claims(), { secret, now: now + 1001 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("reports a forgery as forged even when it is also past its stated expiry", () => {
    const now = Date.now();
    const signature = signPendingCall(claims(), { secret, ttlMs: 1000, now });
    const result = verifyPendingCall(signature, claims({ runId: "run_2" }), {
      secret,
      now: now + 5000,
    });
    expect(result).toEqual({ ok: false, reason: "forged" });
  });

  test("reports a token it cannot even parse as malformed", () => {
    expect(verifyPendingCall("not-a-token", claims(), { secret })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(readSignature("not-a-token")).toBeNull();
  });

  test("refuses to sign without an app secret rather than using a known constant", () => {
    const previous = process.env.SECRET;
    delete process.env.SECRET;
    try {
      expect(() => signPendingCall(claims())).toThrow(/app secret/);
    } finally {
      if (previous !== undefined) process.env.SECRET = previous;
    }
  });
});

describe("spending a signature", () => {
  test("is single use: the second presentation of a token is a replay", () => {
    const signature = signPendingCall(claims(), { secret });
    // Verification is unchanged by spending — the token is still authentic, it
    // is the question that is no longer open.
    expect(consumePendingCall(signature)).toBe(true);
    expect(verifyPendingCall(signature, claims(), { secret }).ok).toBe(true);
    expect(consumePendingCall(signature)).toBe(false);
  });

  test("two calls in the same run get their own nonces", () => {
    const first = signPendingCall(claims(), { secret });
    const second = signPendingCall(claims({ toolCallId: "call_2" }), { secret });
    expect(readSignature(first)?.nonce).not.toBe(readSignature(second)?.nonce);
    expect(consumePendingCall(first)).toBe(true);
    expect(consumePendingCall(second)).toBe(true);
  });

  test("stops holding a nonce once the token it refers to has expired", () => {
    // What bounds the registry: an entry is worth keeping only while the token
    // could still verify, and a token past its expiry is refused by `verify`
    // whether or not the nonce is still on file.
    const now = Date.now();
    const signature = signPendingCall(claims(), { secret, ttlMs: 1000, now });
    expect(consumePendingCall(signature, { now })).toBe(true);
    expect(consumePendingCall(signature, { now: now + 500 })).toBe(false);
    expect(consumePendingCall(signature, { now: now + 2000 })).toBe(true);
  });

  test("spends nothing for a token it cannot read", () => {
    expect(consumePendingCall("not-a-token")).toBe(false);
  });
});

describe("a path on a pending call", () => {
  /** The MAC the flat form has always produced, recomputed from the outside. */
  function flatMac(claim: PendingCallClaims, nonce: string, expiresAt: number) {
    const fields = [
      "agt1",
      claim.runId,
      claim.toolCallId,
      claim.name,
      claim.kind,
      nonce,
      String(expiresAt),
      canonicalize(claim.input),
    ];
    const payload = fields.map((field) => `${field.length}:${field}`).join("");
    return createHmac("sha256", secret).update(payload).digest("base64url");
  }

  test("changes nothing about a call that has none", () => {
    // The one thing that must not move. Every approval already in flight was
    // minted from exactly these eight fields, and a ninth carrying "[]" would
    // make all of them come back looking forged the moment this deploys — the
    // user who clicked Approve before the release would be told they refused.
    const signature = signPendingCall(claims(), { secret });
    const parsed = readSignature(signature)!;
    expect(signature.split(".")[4]).toBe(flatMac(claims(), parsed.nonce, parsed.expiresAt));
  });

  test("treats an empty path as no path, because it says the same thing", () => {
    const signature = signPendingCall(claims({ path: [] }), { secret });
    const parsed = readSignature(signature)!;
    expect(signature.split(".")[4]).toBe(flatMac(claims(), parsed.nonce, parsed.expiresAt));
    expect(verifyPendingCall(signature, claims(), { secret }).ok).toBe(true);
  });

  test("verifies for the path it was minted under", () => {
    const signature = signPendingCall(claims({ path: ["call_outer"] }), { secret });
    expect(verifyPendingCall(signature, claims({ path: ["call_outer"] }), { secret }).ok).toBe(
      true,
    );
  });

  test("cannot be replayed as a top-level call", () => {
    // The whole point of signing the path rather than carrying it beside the
    // signature: a question a sub-agent asked is answered by re-entering the
    // tool above it, and a token that could shed its path would run the tool
    // the user never saw.
    const signature = signPendingCall(claims({ path: ["call_outer"] }), { secret });
    expect(verifyPendingCall(signature, claims(), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("cannot be moved under a different parent, or to a different depth", () => {
    const signature = signPendingCall(claims({ path: ["call_outer"] }), { secret });
    expect(verifyPendingCall(signature, claims({ path: ["call_other"] }), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
    expect(
      verifyPendingCall(signature, claims({ path: ["call_outer", "call_inner"] }), { secret }),
    ).toEqual({ ok: false, reason: "forged" });
  });

  test("keeps path order, because a chain read backwards is a different call", () => {
    const signature = signPendingCall(claims({ path: ["a", "b"] }), { secret });
    expect(verifyPendingCall(signature, claims({ path: ["b", "a"] }), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });
});
