import { describe, expect, test } from "vitest";
import {
  canonicalize,
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

  test("rejects a signature replayed into a different run", () => {
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
