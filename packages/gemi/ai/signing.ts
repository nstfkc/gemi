import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { defaultNonceStore, type NonceStore } from "./store/Nonces";

/**
 * Signing for pending tool calls.
 *
 * A pending call travels through the browser and comes back — in stateless mode
 * the whole history does — so the server cannot trust that what it gets back is
 * what it sent. Without a signature the client asserts not just *that* a call
 * was approved but *what* was approved, and nothing would stop it from
 * returning `approve: true` against an input it rewrote on the way. Signing is
 * what makes the round trip safe, and it is why approvals need no server-side
 * storage at all.
 *
 * What is signed, and what deliberately is not:
 *
 *   signed — `runId`, `toolCallId`, the tool `name`, the `kind` of pending call
 *            and a canonical serialization of the input, plus a nonce, an
 *            expiry, and — for a call a sub-agent asked — the `path` of
 *            tool-call ids it is nested under.
 *   not    — the client's answer. `approve: true` / `approve: false` and a
 *            question's output are the *point* of asking; a client that flips
 *            its own answer has refused, not forged. What the signature buys is
 *            that the answer is bound to the call the server actually made,
 *            with the input the server actually saw.
 *
 * A verified token is not yet an answer the server may act on: it says the
 * question was asked, not that it is still open. `consumePendingCall` at the
 * bottom of this file spends the nonce, which is what makes an approval
 * single-use — see the note there for what that guarantee is worth.
 *
 * `kind` is in there for a specific attack: an `approval`-kind call is one the
 * *server* runs, so a client that reused its signature on the "here is the
 * output" arm of `ClientToolResult` would be fabricating a server tool's result
 * rather than approving it. Binding the kind makes that a forgery instead of a
 * shape the caller has to remember to check.
 *
 * Keys and principals (#447). Neither token kind is MACed with `SECRET`
 * itself: each is keyed with its own HKDF-derived key (`purposeKey` below), so
 * a MAC minted for one purpose — a pending call, a parked-run record, or
 * anything else in the app keyed off `SECRET` (CSRF, sessions) — is never a
 * MAC for another. And each binds the `subject`, the principal the run was
 * started for (`AgentController.runOwner`), so a token minted while user A was
 * asked cannot be answered by user B, even with A's history in hand.
 */

/** Everything the signature commits to. */
export type PendingCallClaims = {
  runId: string;
  toolCallId: string;
  name: string;
  kind: "approval" | "question" | "client";
  input: unknown;
  /**
   * The chain of tool-call ids the call is nested under, outermost first.
   * Absent — or empty, which means the same thing — for a top-level call.
   *
   * A sub-agent's question reaches the user through its parent's pending list,
   * so `toolCallId` stops being an address on its own: two sub-runs under two
   * different tools can each hold a call the outer run never made. Binding the
   * path is what stops a token minted for a call nested under tool call X from
   * being replayed as a top-level call, or as one nested under Y.
   */
  path?: string[];
  /**
   * Who the question was asked of: the run's owner (`AgentController.runOwner`,
   * `user:<id>` by default). `null` or absent is nobody in particular — an
   * anonymous run — and the two are the same claim. A token minted for one
   * subject fails verification for any other, `null` included, so an approval
   * cannot be carried from one user's session to another's.
   */
  subject?: string | null;
};

export type SignOptions = {
  /** Overrides `process.env.SECRET`. Exists for tests; apps use the app key. */
  secret?: string;
  /**
   * Default 24 hours. An approval waits on a human, and humans go to lunch —
   * a short expiry turns "I approved it after standup" into an unexplained
   * failure. Long enough to survive a working day, short enough that a token
   * lifted from a log is not useful next month.
   */
  ttlMs?: number;
  /** Injected clock, so the expiry path is testable without waiting. */
  now?: number;
};

export type VerifyOptions = {
  secret?: string;
  now?: number;
};

/**
 * A discriminated result rather than a boolean, because the two failures are
 * different events: `expired` is a sentence to show the user, `forged` is worth
 * logging and possibly alerting on. Collapsing them loses the only signal that
 * says someone is probing.
 */
export type VerifyResult =
  | { ok: true; runId: string; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "expired" | "forged" };

/**
 * `agt2` is minted; `agt1` is still verified. A v1 token was MACed with the raw
 * `SECRET` and binds no subject — it is accepted so that a question asked
 * before the upgrade can still be answered after it, and it stops mattering on
 * its own when the last one expires (`DEFAULT_TTL_MS` after the deploy). Drop
 * `LEGACY_VERSION` from the accepted set once that window is long past.
 */
const VERSION = "agt2";
const LEGACY_VERSION = "agt1";
const PENDING_VERSIONS = [VERSION, LEGACY_VERSION];
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The latest expiry a legacy token may claim. Every v1 token this process can
 * legitimately see was minted by an earlier deploy with the default TTL, so it
 * expires no later than one TTL after this module loaded. Bounding it here
 * means a v1 token — MACed with the raw `SECRET`, the key this change exists to
 * stop relying on — cannot be forged with a far-future expiry, and that after
 * one TTL of uptime no v1 token verifies at all.
 */
const LEGACY_ACCEPTED_UNTIL = Date.now() + DEFAULT_TTL_MS;

function legacyExpiryOk(expiresAt: number): boolean {
  return expiresAt <= LEGACY_ACCEPTED_UNTIL;
}

/**
 * HKDF `info` labels, one per thing a key signs. Changing a label is a key
 * rotation for that purpose alone.
 */
const PENDING_CALL_PURPOSE = "gemi.ai.pending-call.v1";
const NESTED_RUN_PURPOSE = "gemi.ai.nested-run.v1";
const EXECUTION_RECEIPT_PURPOSE = "gemi.ai.execution-receipt.v1";
const HKDF_SALT = "gemi.ai.signing";

const derivedKeys = new Map<string, Buffer>();

/**
 * A key for one purpose, derived from the app secret with HKDF-SHA256.
 *
 * `SECRET` is also what CSRF tokens and sessions are keyed with. Using it as
 * the HMAC key here would make every one of those a potential oracle for the
 * others; HKDF with a purpose label gives each its own independent key, so a
 * weakness or leak in one use cannot be turned against another — including
 * the two token kinds in this file against each other.
 *
 * Memoized per (purpose, secret): verification is on the request path and the
 * derivation is pure. The map is bounded by the number of purposes times the
 * secrets a process ever sees, which is one outside of tests.
 */
export function purposeKey(purpose: string, override?: string): Buffer {
  const secret = secretKey(override);
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = derivedKeys.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, purpose, 32));
    if (derivedKeys.size > 64) derivedKeys.clear();
    derivedKeys.set(cacheKey, key);
  }
  return key;
}

function secretKey(override?: string): string {
  const secret = override ?? process.env.SECRET;
  if (!secret) {
    // Refusing is the only safe answer. A fallback constant would make every
    // approval in every deployment forgeable by anyone who read this file, and
    // it would do it silently — the feature would appear to work.
    throw new Error(
      "Signing a pending tool call needs an app secret. Set SECRET in the environment.",
    );
  }
  return secret;
}

/**
 * Serializes a value so that the same value always produces the same string.
 *
 * `JSON.stringify` is not enough: it preserves insertion order, so an input
 * that made a round trip through a client — parsed and re-serialized, with the
 * keys in whatever order the parser produced — would hash differently and a
 * legitimate approval would come back looking forged. Keys are sorted,
 * `undefined` members are dropped (they do not survive JSON anyway), and arrays
 * keep their order because in an array order *is* the value.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/**
 * Length-prefixed rather than delimiter-joined. A separator is a place for two
 * different claim sets to hash the same — `runId: "a", toolCallId: "b|c"` and
 * `runId: "a|b", toolCallId: "c"` — and while neither field contains the
 * separator today, that is a property of the id generator, not of this code.
 */
function payload(fields: string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join("");
}

function mac(key: string | Buffer, fields: string[]): Buffer {
  return createHmac("sha256", key).update(payload(fields)).digest();
}

function macMatches(signature: string, expected: Buffer): boolean {
  const presented = Buffer.from(signature.split(".")[4], "base64url");
  // `timingSafeEqual` throws on a length mismatch, and a wrong length is
  // already a public fact about the token — nothing is leaked by checking it
  // first, and everything is leaked by comparing the bytes with `===`.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** The principal as a field: absent and `null` are the same claim. */
function subjectField(subject: string | null | undefined): string {
  return canonicalize(subject ?? null);
}

/**
 * The v2 claim set. Fixed-length: the path is always present (`[]` at the top
 * level) and so is the subject, so there is no optional field to reason about.
 */
function claimFields(claims: PendingCallClaims, nonce: string, expiresAt: number): string[] {
  return [
    VERSION,
    claims.runId,
    claims.toolCallId,
    claims.name,
    claims.kind,
    nonce,
    String(expiresAt),
    canonicalize(claims.input),
    canonicalize(claims.path ?? []),
    subjectField(claims.subject),
  ];
}

/**
 * The v1 claim set, kept only to verify tokens minted before #447.
 *
 * The path is appended, and only when there is one.
 *
 * Byte-identical output for a call with no path is the whole requirement here:
 * every approval already in flight was minted from the eight fields below, and
 * a ninth field carrying `"[]"` or `"undefined"` would invalidate all of them
 * on deploy — the user who clicked Approve before the release would be told
 * their answer was forged. So an absent path adds nothing at all, and an empty
 * array is treated as absent because it says the same thing.
 *
 * `payload` is length-prefixed, so appending a field cannot collide with a
 * longer value in the one before it; that is why this can be an append rather
 * than a new version tag.
 */
function legacyClaimFields(claims: PendingCallClaims, nonce: string, expiresAt: number): string[] {
  const fields = [
    LEGACY_VERSION,
    claims.runId,
    claims.toolCallId,
    claims.name,
    claims.kind,
    nonce,
    String(expiresAt),
    canonicalize(claims.input),
  ];
  if (claims.path && claims.path.length > 0) {
    fields.push(canonicalize(claims.path));
  }
  return fields;
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

/** `agt2.<runId>.<nonce>.<expiry>.<mac>`, all base64url or base36. */
export function signPendingCall(claims: PendingCallClaims, options: SignOptions = {}): string {
  const key = purposeKey(PENDING_CALL_PURPOSE, options.secret);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const nonce = randomBytes(12).toString("base64url");
  const signature = mac(key, claimFields(claims, nonce, expiresAt)).toString("base64url");
  return [VERSION, encode(claims.runId), nonce, expiresAt.toString(36), signature].join(".");
}

/**
 * The metadata a signature carries in the clear.
 *
 * `Agent` needs the issuing `runId` before it can verify anything: the call was
 * signed under the run that made it, and the turn answering it is a *new* run
 * with a new id. Reading it out of the token is safe because the token's own
 * MAC covers it — a client that edits the runId here fails verification, so
 * this is "which run does this claim to belong to", not "which run does the
 * client say it belongs to".
 */
export function readSignature(
  signature: string,
): { runId: string; nonce: string; expiresAt: number } | null {
  return readToken(signature, PENDING_VERSIONS);
}

/**
 * The version tag is checked here and nowhere else, which is what keeps the
 * two token kinds apart: a parked-run record presented where a pending call's
 * signature is expected fails as malformed before its MAC is even looked at,
 * and the other way round. Their claim sets are different lengths and would
 * not collide anyway, but a tag makes that a rule rather than an accident of
 * the field count.
 */
function readToken(
  signature: string,
  versions: readonly string[],
): { runId: string; nonce: string; expiresAt: number; version: string } | null {
  const parts = signature.split(".");
  if (parts.length !== 5 || !versions.includes(parts[0])) {
    return null;
  }
  const expiresAt = Number.parseInt(parts[3], 36);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }
  try {
    return { runId: decode(parts[1]), nonce: parts[2], expiresAt, version: parts[0] };
  } catch {
    return null;
  }
}

export function verifyPendingCall(
  signature: string,
  claims: PendingCallClaims,
  options: VerifyOptions = {},
): VerifyResult {
  const parsed = readToken(signature, PENDING_VERSIONS);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }

  if (parsed.version === LEGACY_VERSION && !legacyExpiryOk(parsed.expiresAt)) {
    return { ok: false, reason: "forged" };
  }
  const expected =
    parsed.version === LEGACY_VERSION
      ? // Raw secret, no subject: see `LEGACY_VERSION`.
        mac(secretKey(options.secret), legacyClaimFields(claims, parsed.nonce, parsed.expiresAt))
      : mac(
          purposeKey(PENDING_CALL_PURPOSE, options.secret),
          claimFields(claims, parsed.nonce, parsed.expiresAt),
        );
  if (!macMatches(signature, expected)) {
    return { ok: false, reason: "forged" };
  }

  // Expiry is checked *after* the MAC on purpose: only a genuine token can be
  // "expired". Reporting a forgery as expired would tell the UI to say "your
  // approval timed out" to someone who was tampering.
  if ((options.now ?? Date.now()) > parsed.expiresAt) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, runId: parsed.runId, nonce: parsed.nonce, expiresAt: parsed.expiresAt };
}

// --- parked sub-runs -----------------------------------------------------

/**
 * What a parked sub-run's record is signed over.
 *
 * `ToolCallPart.nested` is the parent's own record of where a sub-run stopped,
 * and in stateless mode it makes the same trip through the browser a pending
 * call does. The next turn *runs a tool* on the strength of that record — the
 * tool is re-entered because the record says a sub-run under it is waiting on
 * the question being answered — so an unsigned record lets the client choose
 * which tools run, with what input, before any answer is verified. A MAC over
 * what the server actually recorded is what makes the record safe to carry.
 *
 * Only a parked record is signed, because only a parked record executes
 * anything: a finished sub-run is replayed out of its transcript and spends
 * nothing, and a client that forges one has fed its own tool a made-up answer,
 * which a client-carried history already allows everywhere.
 *
 * Deliberately not signed: the transcript. The sub-run resumes from messages
 * the client carried, exactly as the parent does in stateless mode, and the
 * same argument applies — what the signature pins is that the server parked
 * *here*, on *these* calls, with *this* input, and not what was said on the
 * way.
 */
export type NestedRunClaims = {
  /** The root run's id, the one every pending call of the tree is minted under. */
  runId: string;
  /**
   * Tool-call ids from the root down to and including the call the record
   * hangs off. A sub-run's id is not an address on its own for the same reason
   * a nested call's is not: two sub-runs under two different tools can carry
   * the same one.
   */
  path: string[];
  /** The sub-run's own id, so a record cannot be moved between sub-runs. */
  nestedRunId: string;
  /** The tool calls the sub-run is waiting on: every call left open in its transcript. */
  open: string[];
  /**
   * The input the tool that parked was running on, as the transcript carries
   * it. Re-entry runs the tool body with the input the history holds, and the
   * history is the client's — so a record that pinned where the sub-run parked
   * but not what its tool was given would let the client keep the run and
   * rewrite the arguments to anything the schema accepts. The same bargain a
   * pending call makes: the input executed is the input signed.
   */
  input: unknown;
  /** The run's owner, as on `PendingCallClaims.subject`: a record parked for
   *  one principal does not re-enter a tool for another. */
  subject?: string | null;
};

/** `agn2` is minted; `agn1` (raw secret, no subject) is still verified. See
 *  `LEGACY_VERSION`. */
const NESTED_VERSION = "agn2";
const LEGACY_NESTED_VERSION = "agn1";
const NESTED_VERSIONS = [NESTED_VERSION, LEGACY_NESTED_VERSION];

function nestedFields(claims: NestedRunClaims, nonce: string, expiresAt: number): string[] {
  return [
    ...legacyNestedFields(claims, nonce, expiresAt, NESTED_VERSION),
    subjectField(claims.subject),
  ];
}

function legacyNestedFields(
  claims: NestedRunClaims,
  nonce: string,
  expiresAt: number,
  version = LEGACY_NESTED_VERSION,
): string[] {
  return [
    version,
    claims.runId,
    canonicalize(claims.path),
    claims.nestedRunId,
    nonce,
    String(expiresAt),
    // A set, so it is sorted: the ids are read back out of a transcript the
    // client re-serialized, and message order is not part of the claim.
    canonicalize([...claims.open].sort()),
    canonicalize(claims.input),
  ];
}

/**
 * Same shape as a pending call's token, so the same reader serves both — nonce
 * included, and the nonce is spent, by `consumeNestedRun` below. A verified
 * record is permission to run the tool it hangs off, and the tool body runs
 * before the sub-run gets to look at the answer's own nonce; a record that
 * could be presented twice would run the body twice before anything refused
 * the replay. Every park mints a fresh record, so spending one costs a
 * legitimate re-park nothing.
 */
export function signNestedRun(claims: NestedRunClaims, options: SignOptions = {}): string {
  const key = purposeKey(NESTED_RUN_PURPOSE, options.secret);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const nonce = randomBytes(12).toString("base64url");
  const signature = mac(key, nestedFields(claims, nonce, expiresAt)).toString("base64url");
  return [NESTED_VERSION, encode(claims.runId), nonce, expiresAt.toString(36), signature].join(".");
}

/**
 * The run that verifies a record is never the run that minted it — the turn
 * answering a question is a new run with a new id — so the minting run's id is
 * read out of the token rather than asked of the caller, which has no other
 * source for it. The MAC covers it, so a client that edits the id in the clear
 * fails here rather than being believed.
 */
export function verifyNestedRun(
  signature: string,
  claims: Omit<NestedRunClaims, "runId">,
  options: VerifyOptions = {},
): VerifyResult {
  const parsed = readToken(signature, NESTED_VERSIONS);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }

  if (parsed.version === LEGACY_NESTED_VERSION && !legacyExpiryOk(parsed.expiresAt)) {
    return { ok: false, reason: "forged" };
  }
  const full = { ...claims, runId: parsed.runId };
  const expected =
    parsed.version === LEGACY_NESTED_VERSION
      ? mac(secretKey(options.secret), legacyNestedFields(full, parsed.nonce, parsed.expiresAt))
      : mac(
          purposeKey(NESTED_RUN_PURPOSE, options.secret),
          nestedFields(full, parsed.nonce, parsed.expiresAt),
        );
  if (!macMatches(signature, expected)) {
    return { ok: false, reason: "forged" };
  }

  // A parked record outlives its usefulness with the answers it exists to
  // deliver: those expire on the pending call's TTL, and a record older than
  // that can route nothing that would still verify.
  if ((options.now ?? Date.now()) > parsed.expiresAt) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, runId: parsed.runId, nonce: parsed.nonce, expiresAt: parsed.expiresAt };
}

// --- single use ----------------------------------------------------------

/**
 * Spending a nonce.
 *
 * The MAC makes a token unforgeable; it does not make it single-use. Without
 * this a captured signature approves the same call again every time it is
 * presented, because a token that carries its own `runId` is a token that
 * asserts its own binding — which is no binding at all. Verifying tells you the
 * server once asked this exact question; spending the nonce is what says nobody
 * has answered it yet.
 *
 * Where spent nonces live is a `NonceStore` (`store/Nonces.ts`, #445). The
 * default is the process-wide `MemoryNonceStore`, which is exact for one
 * instance; an app with several instances gives the agent a shared store
 * (`RedisNonceStore`, or a table) so a rewound history cannot be replayed once
 * against each of them. The store's `consume` is insert-if-absent, so two
 * instances answering at once cannot both win.
 *
 * The other guard is the app's own message store: once a call has a result
 * next to it, the call is no longer open and the answer has nothing to attach
 * to. This is what stands in for that in stateless mode, where the history the
 * client returns can be rewound to before the result existed.
 */

/**
 * The id an approved call's execution receipt is kept under (#458).
 *
 * Deterministic in the call the signature covers — the issuing run, the tool
 * call id, the tool, its canonical input, the nesting path and the subject —
 * and in nothing else, so every presentation of one approval, on any instance,
 * names the same receipt. Not in the nonce or expiry: those identify one
 * *token*, and a receipt identifies the *execution* it authorizes.
 *
 * An HMAC under its own HKDF-derived key rather than a plain hash, so an id in
 * a shared store is neither a MAC for anything else nor something a client can
 * compute to probe the store for another user's calls.
 */
export function executionReceiptId(
  agent: string,
  claims: PendingCallClaims,
  options: { secret?: string } = {},
): string {
  const key = purposeKey(EXECUTION_RECEIPT_PURPOSE, options.secret);
  return mac(key, [
    agent,
    claims.runId,
    claims.toolCallId,
    claims.name,
    claims.kind,
    canonicalize(claims.input),
    canonicalize(claims.path ?? []),
    subjectField(claims.subject),
  ]).toString("base64url");
}

/**
 * Spends a signature's nonce in `store`. `false` means it was already spent —
 * the answer is a replay and must not be acted on — or the token is malformed.
 * A store that throws rejects; the caller refuses the answer.
 *
 * Separate from `verifyPendingCall` rather than folded into it, because verify
 * is a pure question a caller may want to ask twice (logging a forgery, say)
 * and this one is a state change that must happen exactly once per answer.
 */
export function spendPendingCall(signature: string, store: NonceStore): Promise<boolean> {
  return spendIn(store, readSignature(signature));
}

/**
 * Spends a parked-run record's nonce, on the same store and the same terms.
 * `false` means the record has already re-entered its tool once — the turn is
 * a replay of a history from before the answer was delivered, and the body
 * must not run again on it.
 */
export function spendNestedRun(signature: string, store: NonceStore): Promise<boolean> {
  return spendIn(store, readToken(signature, NESTED_VERSIONS));
}

async function spendIn(
  store: NonceStore,
  parsed: { nonce: string; expiresAt: number } | null,
): Promise<boolean> {
  if (!parsed) return false;
  return store.consume(parsed.nonce, parsed.expiresAt);
}

/** `spendPendingCall` on the process-wide default store, synchronously.
 *  `now` is injectable for tests. */
export function consumePendingCall(signature: string, options: VerifyOptions = {}): boolean {
  const parsed = readSignature(signature);
  return parsed
    ? defaultNonceStore.consumeSync(parsed.nonce, parsed.expiresAt, options.now)
    : false;
}

/** `spendNestedRun` on the process-wide default store, synchronously. */
export function consumeNestedRun(signature: string, options: VerifyOptions = {}): boolean {
  const parsed = readToken(signature, NESTED_VERSIONS);
  return parsed
    ? defaultNonceStore.consumeSync(parsed.nonce, parsed.expiresAt, options.now)
    : false;
}
