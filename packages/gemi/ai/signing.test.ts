import { createHmac, hkdfSync, randomBytes } from "crypto";
import { describe, expect, test } from "vitest";
import {
  canonicalize,
  consumeNestedRun,
  consumePendingCall,
  executionReceiptId,
  purposeKey,
  readSignature,
  signNestedRun,
  signPendingCall,
  verifyNestedRun,
  verifyPendingCall,
  type NestedRunClaims,
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
    const roundTripped = JSON.parse(JSON.stringify({ amountCents: 4200, orderId: "ord_1" }));
    expect(verifyPendingCall(signature, claims({ input: roundTripped }), { secret }).ok).toBe(true);
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
  test("treats an empty path as no path, because it says the same thing", () => {
    const signature = signPendingCall(claims({ path: [] }), { secret });
    expect(verifyPendingCall(signature, claims(), { secret }).ok).toBe(true);
    expect(
      verifyPendingCall(signPendingCall(claims(), { secret }), claims({ path: [] }), { secret }).ok,
    ).toBe(true);
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

describe("a signed parked-run record", () => {
  const record = (overrides: Partial<NestedRunClaims> = {}): NestedRunClaims => ({
    runId: "run_1",
    path: ["call_outer"],
    nestedRunId: "run_sub",
    open: ["q1", "q2"],
    input: { path: "notes.md" },
    ...overrides,
  });
  /** What the verifying run has in front of it: everything but the minting run's id. */
  const presented = ({ runId: _runId, ...rest }: NestedRunClaims) => rest;

  test("verifies against what was recorded, and carries the recording run in the clear", () => {
    const signature = signNestedRun(record(), { secret });
    const result = verifyNestedRun(signature, presented(record()), { secret });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.runId).toBe("run_1");
    }
  });

  test("reads the open calls as a set, because they come back out of a re-serialized transcript", () => {
    const signature = signNestedRun(record(), { secret });
    expect(
      verifyNestedRun(signature, presented(record({ open: ["q2", "q1"] })), { secret }).ok,
    ).toBe(true);
  });

  test("rejects a record widened to a question the sub-run never asked", () => {
    const signature = signNestedRun(record(), { secret });
    expect(
      verifyNestedRun(signature, presented(record({ open: ["q1", "q2", "q9"] })), { secret }),
    ).toEqual({ ok: false, reason: "forged" });
  });

  test("rejects a record whose tool input was rewritten, however well-typed", () => {
    // The record is what re-enters the tool, and the tool runs on the input
    // the transcript carries — so a record that verified against any input
    // would be a signed permission to run the tool with arguments of the
    // client's choosing.
    const signature = signNestedRun(record(), { secret });
    expect(
      verifyNestedRun(signature, presented(record({ input: { path: "/etc/secrets.md" } })), {
        secret,
      }),
    ).toEqual({ ok: false, reason: "forged" });
    // Key order is not part of the input: it comes back out of a client's
    // serializer, as an approval's does.
    expect(
      verifyNestedRun(
        signNestedRun(record({ input: { b: 1, a: 2 } }), { secret }),
        presented(record({ input: { a: 2, b: 1 } })),
        { secret },
      ).ok,
    ).toBe(true);
  });

  test("is spent by the re-entry it permits, and a second presentation is a replay", () => {
    const signature = signNestedRun(record(), { secret });
    expect(consumeNestedRun(signature)).toBe(true);
    // Still authentic — what has changed is that the tool has run on it.
    expect(verifyNestedRun(signature, presented(record()), { secret }).ok).toBe(true);
    expect(consumeNestedRun(signature)).toBe(false);
    // A pending call's token is not a record, and spends nothing here.
    expect(consumeNestedRun(signPendingCall(claims(), { secret }))).toBe(false);
  });

  test("cannot be moved under another tool call, or onto another sub-run", () => {
    const signature = signNestedRun(record(), { secret });
    expect(
      verifyNestedRun(signature, presented(record({ path: ["call_other"] })), { secret }),
    ).toEqual({ ok: false, reason: "forged" });
    expect(
      verifyNestedRun(signature, presented(record({ nestedRunId: "run_other" })), { secret }),
    ).toEqual({ ok: false, reason: "forged" });
  });

  test("is not a pending call's signature, in either direction", () => {
    // One tag per token kind: a record presented as an answer, or an answer
    // presented as a record, is malformed before its MAC is even compared.
    expect(verifyPendingCall(signNestedRun(record(), { secret }), claims(), { secret })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      verifyNestedRun(signPendingCall(claims(), { secret }), presented(record()), { secret }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  test("expires with the answers it exists to route", () => {
    const now = Date.now();
    const signature = signNestedRun(record(), { secret, ttlMs: 1000, now });
    expect(verifyNestedRun(signature, presented(record()), { secret, now: now + 500 }).ok).toBe(
      true,
    );
    expect(verifyNestedRun(signature, presented(record()), { secret, now: now + 1001 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

// --- #447: purpose-specific keys, bound principals --------------------------

/** A token in the given format with a MAC computed from the outside. */
function forge(
  version: string,
  runId: string,
  key: string | Buffer,
  fields: string[],
  expiresAt = Date.now() + 60_000,
) {
  const nonce = randomBytes(12).toString("base64url");
  const payload = fields
    .map((field) => field.replace("{nonce}", nonce).replace("{exp}", String(expiresAt)))
    .map((field) => `${field.length}:${field}`)
    .join("");
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return [
    version,
    Buffer.from(runId).toString("base64url"),
    nonce,
    expiresAt.toString(36),
    mac,
  ].join(".");
}

describe("the signing key (#447)", () => {
  test("is derived per purpose with HKDF, not the raw app secret", () => {
    const pending = purposeKey("gemi.ai.pending-call.v1", secret);
    const nested = purposeKey("gemi.ai.nested-run.v1", secret);
    expect(pending).toEqual(
      Buffer.from(hkdfSync("sha256", secret, "gemi.ai.signing", "gemi.ai.pending-call.v1", 32)),
    );
    expect(pending.equals(nested)).toBe(false);
    expect(pending.equals(Buffer.from(secret))).toBe(false);
  });

  test("a MAC made with the raw SECRET over the new claim set is a forgery", () => {
    // What CSRF tokens and sessions are keyed with. Before #447 an HMAC under
    // `SECRET` over the right bytes was a valid approval; now it is not.
    const c = claims();
    const fields = [
      "agt2",
      c.runId,
      c.toolCallId,
      c.name,
      c.kind,
      "{nonce}",
      "{exp}",
      canonicalize(c.input),
      canonicalize([]),
      canonicalize(null),
    ];
    const raw = forge("agt2", c.runId, secret, fields);
    expect(verifyPendingCall(raw, c, { secret })).toEqual({ ok: false, reason: "forged" });
    // The same bytes under the purpose key verify, which is what makes the
    // line above a statement about the key and not about the field layout.
    const keyed = forge("agt2", c.runId, purposeKey("gemi.ai.pending-call.v1", secret), fields);
    expect(verifyPendingCall(keyed, c, { secret }).ok).toBe(true);
  });

  test("a parked-run record relabelled as a pending call is forged, and the other way round", () => {
    // Cross-purpose replay with the tag rewritten so the version check passes:
    // what refuses it is that each kind has its own key.
    const record: NestedRunClaims = {
      runId: "run_1",
      path: ["call_outer"],
      nestedRunId: "run_sub",
      open: ["q1"],
      input: {},
    };
    const asPending = signNestedRun(record, { secret }).replace(/^agn2\./, "agt2.");
    expect(verifyPendingCall(asPending, claims(), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });

    const asRecord = signPendingCall(claims(), { secret }).replace(/^agt2\./, "agn2.");
    const { runId: _runId, ...presented } = record;
    expect(verifyNestedRun(asRecord, presented, { secret })).toEqual({
      ok: false,
      reason: "forged",
    });

    // And a token minted under one purpose's key with the other's field layout
    // fails too: the key, not the layout, is the boundary.
    const c = claims();
    const fields = [
      "agt2",
      c.runId,
      c.toolCallId,
      c.name,
      c.kind,
      "{nonce}",
      "{exp}",
      canonicalize(c.input),
      canonicalize([]),
      canonicalize(null),
    ];
    const wrongKey = forge("agt2", c.runId, purposeKey("gemi.ai.nested-run.v1", secret), fields);
    expect(verifyPendingCall(wrongKey, c, { secret })).toEqual({ ok: false, reason: "forged" });
  });
});

describe("the principal in the claims (#447)", () => {
  test("a pending call verifies for the subject it was minted for", () => {
    const signature = signPendingCall(claims({ subject: "user:a" }), { secret });
    expect(verifyPendingCall(signature, claims({ subject: "user:a" }), { secret }).ok).toBe(true);
  });

  test("a pending call minted for one user is forged for another, or for nobody", () => {
    const signature = signPendingCall(claims({ subject: "user:a" }), { secret });
    for (const subject of ["user:b", null, undefined, ""]) {
      expect(verifyPendingCall(signature, claims({ subject }), { secret })).toEqual({
        ok: false,
        reason: "forged",
      });
    }
  });

  test("an anonymous pending call is not answerable by a signed-in user", () => {
    const signature = signPendingCall(claims({ subject: null }), { secret });
    expect(verifyPendingCall(signature, claims(), { secret }).ok).toBe(true);
    expect(verifyPendingCall(signature, claims({ subject: "user:b" }), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("a parked-run record minted for one user is forged for another", () => {
    const record = {
      path: ["call_outer"],
      nestedRunId: "run_sub",
      open: ["q1"],
      input: { a: 1 },
    };
    const signature = signNestedRun({ ...record, runId: "run_1", subject: "user:a" }, { secret });
    expect(verifyNestedRun(signature, { ...record, subject: "user:a" }, { secret }).ok).toBe(true);
    expect(verifyNestedRun(signature, { ...record, subject: "user:b" }, { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
    expect(verifyNestedRun(signature, { ...record, subject: null }, { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });
});

describe("tokens minted before #447", () => {
  /** A v1 pending-call token: raw secret, eight fields plus an optional path. */
  function legacyPending(claim: PendingCallClaims, expiresAt?: number) {
    const fields = [
      "agt1",
      claim.runId,
      claim.toolCallId,
      claim.name,
      claim.kind,
      "{nonce}",
      "{exp}",
      canonicalize(claim.input),
    ];
    if (claim.path && claim.path.length > 0) fields.push(canonicalize(claim.path));
    return forge("agt1", claim.runId, secret, fields, expiresAt);
  }

  test("still verify, so a question asked before the upgrade can be answered after it", () => {
    const signature = legacyPending(claims());
    expect(verifyPendingCall(signature, claims(), { secret }).ok).toBe(true);
    expect(readSignature(signature)?.runId).toBe("run_1");
    expect(consumePendingCall(signature)).toBe(true);
    expect(consumePendingCall(signature)).toBe(false);

    const nested = legacyPending(claims({ path: ["call_outer"] }));
    expect(verifyPendingCall(nested, claims({ path: ["call_outer"] }), { secret }).ok).toBe(true);
    expect(verifyPendingCall(nested, claims(), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("still verify as parked-run records", () => {
    const fields = [
      "agn1",
      "run_1",
      canonicalize(["call_outer"]),
      "run_sub",
      "{nonce}",
      "{exp}",
      canonicalize(["q1"]),
      canonicalize({}),
    ];
    const signature = forge("agn1", "run_1", secret, fields);
    const presented = { path: ["call_outer"], nestedRunId: "run_sub", open: ["q1"], input: {} };
    expect(verifyNestedRun(signature, presented, { secret }).ok).toBe(true);
    expect(consumeNestedRun(signature)).toBe(true);
  });

  test("are refused with an expiry no pre-upgrade token could have", () => {
    // A v1 MAC is over the raw SECRET; bounding its expiry to one TTL past
    // startup is what keeps that from being a standing forgery target.
    const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(verifyPendingCall(legacyPending(claims(), farFuture), claims(), { secret })).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  test("are no longer minted", () => {
    expect(signPendingCall(claims(), { secret }).startsWith("agt2.")).toBe(true);
    expect(
      signNestedRun(
        { runId: "r", path: ["c"], nestedRunId: "s", open: [], input: null },
        { secret },
      ).startsWith("agn2."),
    ).toBe(true);
  });
});

describe("an execution receipt id (#458)", () => {
  const id = (overrides: Partial<PendingCallClaims> = {}, agent = "support", key = secret) =>
    executionReceiptId(agent, claims(overrides), { secret: key });

  test("is the same for the same call, whatever order its input's keys arrive in", () => {
    expect(id()).toBe(id({ input: { amountCents: 4200, orderId: "ord_1" } }));
  });

  test.each([
    ["run", { runId: "run_2" }],
    ["tool call", { toolCallId: "call_2" }],
    ["tool", { name: "cancelOrder" }],
    ["input", { input: { orderId: "ord_2", amountCents: 4200 } }],
    ["path", { path: ["outer"] }],
    ["subject", { subject: "user:2" }],
  ] as const)("differs by %s", (_, overrides) => {
    expect(id(overrides as Partial<PendingCallClaims>)).not.toBe(id());
  });

  test("differs by agent and by secret", () => {
    expect(id({}, "billing")).not.toBe(id());
    expect(id({}, "support", "another-secret")).not.toBe(id());
  });

  test("is not the pending call's MAC under the same claims", () => {
    const signature = signPendingCall(claims(), { secret });
    expect(signature).not.toContain(id());
  });
});
