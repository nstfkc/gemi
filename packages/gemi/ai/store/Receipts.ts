import { app } from "../../foundation/app";
import { RedisManager } from "../../services/redis/RedisManager";
import type { ToolResultPart } from "../types";

/**
 * EXECUTION RECEIPTS: what makes an approved tool run at most once (#458).
 *
 * A pending call's signature stops an approval being forged, and its spent
 * nonce (`NonceStore`, #445) stops it being *accepted* twice. Neither records
 * what the approved tool did. So a retried submit whose response was lost, a
 * proxy retry, or an answer that reaches two instances whose nonce stores are
 * not shared, either runs `execute` again for a tool that already charged a
 * card, or is refused and the user is told their approval was not used when
 * it was.
 *
 * A receipt store closes that. Before an approved tool runs, the run claims a
 * deterministic execution id (an HMAC, under its own HKDF-derived key, of the
 * call the signature covers: issuing run, tool call id, tool name, canonical
 * input, nesting path and subject). The claim answers one of three things:
 *
 *   claimed  — nobody has run it: run it, then `complete` with its result.
 *   replay   — it already ran: the stored result is returned as the call's
 *              result, and the tool is not run.
 *   blocked  — a claim is held but no result recorded: another instance is
 *              running it right now, or the process that was running it died.
 *              The call gets a `tool_error` result the model can read, and the
 *              tool is not run. Not knowing whether a side effect happened is
 *              exactly the case where running it again is wrong.
 *
 * Opt-in: `AgentController.receipts` (or `receipts` on `Agent.stream`). Without
 * a store an approved tool runs exactly as before.
 *
 * Implementations:
 *
 *   MemoryReceiptStore — one process, lost on restart.
 *   RedisReceiptStore  — on the app's Redis; shared and atomic.
 *   your own           — e.g. a table keyed by the execution id:
 *
 *     CREATE TABLE agent_tool_receipts (
 *       id          text PRIMARY KEY,
 *       result      jsonb,              -- NULL while the call is running
 *       expires_at  timestamptz NOT NULL
 *     );
 *
 *     class DbReceiptStore implements ReceiptStore {
 *       async claim(id, expiresAt) {
 *         const inserted = await db.$executeRaw`
 *           INSERT INTO agent_tool_receipts (id, expires_at)
 *           VALUES (${id}, ${new Date(expiresAt)})
 *           ON CONFLICT (id) DO NOTHING`;
 *         if (inserted === 1) return { status: "claimed" };
 *         const [row] = await db.$queryRaw`
 *           SELECT result FROM agent_tool_receipts WHERE id = ${id}`;
 *         return row?.result ? { status: "replay", result: row.result } : { status: "blocked" };
 *       }
 *       async complete(id, result) {
 *         await db.$executeRaw`
 *           UPDATE agent_tool_receipts SET result = ${result} WHERE id = ${id}`;
 *       }
 *       async release(id) {
 *         await db.$executeRaw`
 *           DELETE FROM agent_tool_receipts WHERE id = ${id} AND result IS NULL`;
 *       }
 *     }
 *     // and, from a cron: DELETE FROM agent_tool_receipts WHERE expires_at < now()
 *
 * A receipt only has to outlive the token it answers: past `expiresAt` the
 * signature fails verification on its own, so the call cannot be presented
 * again and the receipt may be dropped.
 */
export interface ReceiptStore {
  /**
   * Claims `executionId` until `expiresAt` (epoch milliseconds), if nobody has.
   * Must be atomic across every process sharing the store: two concurrent
   * claims never both answer `claimed`.
   *
   * A rejection refuses the answer, as a `NonceStore` that throws does: an
   * idempotency guard that runs the tool anyway when its store is down is not
   * a guard.
   */
  claim(executionId: string, expiresAt: number): Promise<ReceiptClaim>;
  /**
   * Records the result of a claimed execution, kept until `expiresAt`. Called
   * once the tool's result is known, which may be after the run that claimed
   * it was stopped. A rejection is logged; the claim then stays held, so a
   * replay is `blocked` rather than run again.
   */
  complete(executionId: string, result: ToolResultPart, expiresAt: number): Promise<void>;
  /**
   * Drops a claim that never ran: the answer was refused after it was claimed
   * (its nonce was already spent). A recorded result is never released.
   */
  release(executionId: string): Promise<void>;
}

export type ReceiptClaim =
  | { status: "claimed" }
  | { status: "replay"; result: ToolResultPart }
  | { status: "blocked" };

type MemoryReceipt = { result?: ToolResultPart; expiresAt: number };

/**
 * The in-process store. Holds each receipt until its token expires, swept
 * amortized O(1) per claim. Results are copied in and out, so a caller that
 * edits the part it was handed cannot change what a replay returns.
 */
export class MemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, MemoryReceipt>();
  private sweepAt = 1024;
  /** Injectable for tests. */
  constructor(private readonly now: () => number = Date.now) {}

  async claim(executionId: string, expiresAt: number): Promise<ReceiptClaim> {
    const now = this.now();
    if (this.receipts.size >= this.sweepAt) this.sweep(now);
    const existing = this.receipts.get(executionId);
    if (existing && existing.expiresAt > now) {
      return existing.result
        ? { status: "replay", result: structuredClone(existing.result) }
        : { status: "blocked" };
    }
    this.receipts.set(executionId, { expiresAt });
    return { status: "claimed" };
  }

  async complete(executionId: string, result: ToolResultPart, expiresAt: number): Promise<void> {
    this.receipts.set(executionId, { result: structuredClone(result), expiresAt });
  }

  async release(executionId: string): Promise<void> {
    const existing = this.receipts.get(executionId);
    if (existing && !existing.result) this.receipts.delete(executionId);
  }

  get size(): number {
    return this.receipts.size;
  }

  private sweep(now: number) {
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) this.receipts.delete(id);
    }
    this.sweepAt = Math.max(1024, this.receipts.size * 2);
  }
}

/** The slice of Bun's `RedisClient` this store needs: `send(command, args)`. */
export interface ReceiptRedisClient {
  send(command: string, args: string[]): Promise<any>;
}

export interface RedisReceiptStoreOptions {
  /**
   * Client to run against. Defaults to the app's shared client from
   * `RedisServiceProvider`, resolved on first use.
   */
  client?: ReceiptRedisClient;
  /** Key namespace. Defaults to `gemi:ai:receipt`. */
  prefix?: string;
}

const PENDING = "pending";
const DONE = "done:";

/** `SET NX`, and on a miss the value that was there, in one round trip. */
const CLAIM_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 'claimed' end
local held = redis.call('GET', KEYS[1])
if not held then return ARGV[1] end
return held`;

/** Deletes the key only while it is an unfinished claim. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Receipts in Redis, shared by every instance of the app. A claim is a
 * `SET ... NX` run in a script with the read that follows a miss, so claiming
 * is atomic; `PX` drops each key at the token's expiry.
 *
 * ```ts
 * const receipts = new RedisReceiptStore();
 *
 * class ChatController extends AgentController<typeof chat> {
 *   agent = chat;
 *   receipts = receipts;
 * }
 * ```
 */
export class RedisReceiptStore implements ReceiptStore {
  private readonly injectedClient?: ReceiptRedisClient;
  private readonly prefix: string;

  constructor(options: RedisReceiptStoreOptions = {}) {
    this.injectedClient = options.client;
    this.prefix = options.prefix ?? "gemi:ai:receipt";
  }

  async claim(executionId: string, expiresAt: number): Promise<ReceiptClaim> {
    const reply = await this.client.send("EVAL", [
      CLAIM_SCRIPT,
      "1",
      this.key(executionId),
      PENDING,
      ttl(expiresAt),
    ]);
    // Anything else the script did not return (a client that maps an odd
    // reply to `null`, say) is `blocked`: never a reason to run the tool.
    if (reply === "claimed") return { status: "claimed" };
    const held = String(reply ?? "");
    if (held.startsWith(DONE)) {
      return { status: "replay", result: JSON.parse(held.slice(DONE.length)) as ToolResultPart };
    }
    return { status: "blocked" };
  }

  async complete(executionId: string, result: ToolResultPart, expiresAt: number): Promise<void> {
    await this.client.send("SET", [
      this.key(executionId),
      DONE + JSON.stringify(result),
      "PX",
      ttl(expiresAt),
    ]);
  }

  async release(executionId: string): Promise<void> {
    await this.client.send("EVAL", [RELEASE_SCRIPT, "1", this.key(executionId), PENDING]);
  }

  private key(executionId: string) {
    return `${this.prefix}:${executionId}`;
  }

  private get client(): ReceiptRedisClient {
    if (this.injectedClient) return this.injectedClient;
    const container = app();
    const client = container.bound(RedisManager) ? container.make(RedisManager).client : undefined;
    if (!client) {
      throw new Error(
        "RedisReceiptStore could not reach the Redis client. Register RedisServiceProvider on your application, or pass a client: new RedisReceiptStore({ client }).",
      );
    }
    return client;
  }
}

/** At least 1ms: `PX 0` is an error. */
function ttl(expiresAt: number): string {
  return String(Math.max(1, Math.ceil(expiresAt - Date.now())));
}
