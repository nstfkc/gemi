import { createHmac, randomBytes, timingSafeEqual } from "crypto";

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

const VERSION = "agt1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

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

function mac(secret: string, fields: string[]): Buffer {
  return createHmac("sha256", secret).update(payload(fields)).digest();
}

/**
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
function claimFields(claims: PendingCallClaims, nonce: string, expiresAt: number): string[] {
  const fields = [
    VERSION,
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

/** `agt1.<runId>.<nonce>.<expiry>.<mac>`, all base64url or base36. */
export function signPendingCall(claims: PendingCallClaims, options: SignOptions = {}): string {
  const secret = secretKey(options.secret);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const nonce = randomBytes(12).toString("base64url");
  const signature = mac(secret, claimFields(claims, nonce, expiresAt)).toString("base64url");
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
  return readToken(signature, VERSION);
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
  version: string,
): { runId: string; nonce: string; expiresAt: number } | null {
  const parts = signature.split(".");
  if (parts.length !== 5 || parts[0] !== version) {
    return null;
  }
  const expiresAt = Number.parseInt(parts[3], 36);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }
  try {
    return { runId: decode(parts[1]), nonce: parts[2], expiresAt };
  } catch {
    return null;
  }
}

export function verifyPendingCall(
  signature: string,
  claims: PendingCallClaims,
  options: VerifyOptions = {},
): VerifyResult {
  const secret = secretKey(options.secret);
  const parsed = readSignature(signature);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }

  const presented = Buffer.from(signature.split(".")[4], "base64url");
  const expected = mac(secret, claimFields(claims, parsed.nonce, parsed.expiresAt));
  // `timingSafeEqual` throws on a length mismatch, and a wrong length is
  // already a public fact about the token — nothing is leaked by checking it
  // first, and everything is leaked by comparing the bytes with `===`.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
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
 * *here*, on *these* calls, and not what was said on the way.
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
};

const NESTED_VERSION = "agn1";

function nestedFields(claims: NestedRunClaims, nonce: string, expiresAt: number): string[] {
  return [
    NESTED_VERSION,
    claims.runId,
    canonicalize(claims.path),
    claims.nestedRunId,
    nonce,
    String(expiresAt),
    // A set, so it is sorted: the ids are read back out of a transcript the
    // client re-serialized, and message order is not part of the claim.
    canonicalize([...claims.open].sort()),
  ];
}

/**
 * Same shape as a pending call's token, so the same reader serves both. The
 * nonce is entropy and nothing more: a record is a fact about the transcript,
 * not a permission that is used up, and a second re-entry on the same record
 * is stopped by the nonce on the *answer* it is delivering.
 */
export function signNestedRun(claims: NestedRunClaims, options: SignOptions = {}): string {
  const secret = secretKey(options.secret);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const nonce = randomBytes(12).toString("base64url");
  const signature = mac(secret, nestedFields(claims, nonce, expiresAt)).toString("base64url");
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
  const secret = secretKey(options.secret);
  const parsed = readToken(signature, NESTED_VERSION);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }

  const presented = Buffer.from(signature.split(".")[4], "base64url");
  const expected = mac(
    secret,
    nestedFields({ ...claims, runId: parsed.runId }, parsed.nonce, parsed.expiresAt),
  );
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
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
 * Nonces already spent, mapped to the moment they stop mattering.
 *
 * The MAC makes a token unforgeable; it does not make it single-use. Without
 * this a captured signature approves the same call again every time it is
 * presented, because a token that carries its own `runId` is a token that
 * asserts its own binding — which is no binding at all. Verifying tells you the
 * server once asked this exact question; spending the nonce is what says nobody
 * has answered it yet.
 *
 * Deliberately in memory, and deliberately not a hard guarantee:
 *
 *   bounded — an entry lives at most as long as the token's TTL, and the sweep
 *             below is amortized O(1), so the map is bounded by the approvals
 *             actually issued in one TTL window rather than by uptime.
 *   local   — one process. A second replica has never seen the nonce and will
 *             accept it, so this closes the replay window rather than sealing
 *             it. That is still worth having and it fails open, which is the
 *             only direction a cache may fail: a lost registry costs a replay,
 *             never a legitimate approval that stops working.
 *
 * The stronger guard is the app's own message store: once a call has a result
 * next to it, the call is no longer open and the answer has nothing to attach
 * to. This is what stands in for that in stateless mode, where the history the
 * client returns can be rewound to before the result existed.
 */
const spent = new Map<string, number>();

/** Sweep when the map has grown past this, so sweeping costs O(1) per insert
 *  amortized instead of walking every entry on every approval. */
let sweepAt = 1024;

function sweep(now: number) {
  for (const [nonce, expiresAt] of spent) {
    if (expiresAt <= now) spent.delete(nonce);
  }
  sweepAt = Math.max(1024, spent.size * 2);
}

/**
 * Spends a signature's nonce. `false` means it was already spent — the answer
 * is a replay and must not be acted on.
 *
 * Separate from `verifyPendingCall` rather than folded into it, because verify
 * is a pure question a caller may want to ask twice (logging a forgery, say)
 * and this one is a state change that must happen exactly once per answer.
 */
export function consumePendingCall(signature: string, options: VerifyOptions = {}): boolean {
  const parsed = readSignature(signature);
  if (!parsed) return false;
  const now = options.now ?? Date.now();
  if (spent.size >= sweepAt) sweep(now);
  const spentUntil = spent.get(parsed.nonce);
  // A record past its own expiry binds nothing: the token it refers to fails
  // verification on its own, so holding the nonce would only grow the map.
  if (spentUntil !== undefined && spentUntil > now) return false;
  spent.set(parsed.nonce, parsed.expiresAt);
  return true;
}
