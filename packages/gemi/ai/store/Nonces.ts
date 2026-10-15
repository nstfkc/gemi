import { app } from "../../foundation/app";
import { isUniqueConstraintError } from "../../orm/errors";
import { RedisManager } from "../../services/redis/RedisManager";

/**
 * SPENT NONCES: what makes a signed answer single-use (#445).
 *
 * A pending call's signature (and a parked sub-run's record) carries a nonce
 * and an expiry. Verifying the MAC says the server once asked this exact
 * question; spending the nonce says nobody has answered it yet. Without that a
 * stateless client rewinds its history to before the result and replays the
 * same signed approval, and the human who approved once has approved forever.
 *
 * Spending has to be shared by every process that can receive the answer, and
 * it has to be atomic: insert-if-absent, so two instances handed the same
 * answer at the same moment cannot both be told "first". A check followed by a
 * write is not enough, since both reads can happen before either write.
 *
 * Implementations:
 *
 *   MemoryNonceStore — the default. One process, lost on restart. Correct for
 *                      a single instance; with several, each instance accepts
 *                      the same answer once.
 *   RedisNonceStore  — `SET key 1 PX <ttl> NX` on the app's Redis. Shared,
 *                      atomic, and Redis drops each key at the token's expiry.
 *   PrismaNonceStore — an insert keyed by the nonce, in a table of the app's
 *                      database (a gemi ORM model or a Prisma delegate).
 *   your own         — e.g. a table with the nonce as its primary key:
 *
 *     class DbNonceStore implements NonceStore {
 *       async consume(nonce, expiresAt) {
 *         // INSERT ... ON CONFLICT (nonce) DO NOTHING, then look at the row count.
 *         const inserted = await db.$executeRaw`
 *           INSERT INTO agent_nonces (nonce, expires_at)
 *           VALUES (${nonce}, ${new Date(expiresAt)})
 *           ON CONFLICT (nonce) DO NOTHING`;
 *         return inserted === 1;
 *       }
 *     }
 *     // and, from a cron: DELETE FROM agent_nonces WHERE expires_at < now()
 *
 * Expired tokens fail verification on their own, so a store only has to
 * remember a nonce until `expiresAt`; anything older may be dropped.
 */
export interface NonceStore {
  /**
   * Records `nonce` as spent until `expiresAt` (epoch milliseconds). Resolves
   * `true` when this call is the one that spent it, `false` when it was
   * already spent. Must be atomic across every process sharing the store.
   *
   * A rejection is treated as "could not be spent": the answer is refused,
   * and the user is asked again. A replay guard that silently lets an answer
   * through when its backing store is down is not a guard.
   */
  consume(nonce: string, expiresAt: number): Promise<boolean>;
}

/**
 * The in-process store. Bounded by the tokens issued in one TTL window: an
 * entry is dropped once its token expires, swept amortized O(1) per insert.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly spent = new Map<string, number>();
  /** Sweep when the map has grown past this, so sweeping costs O(1) per insert
   *  amortized instead of walking every entry on every answer. */
  private sweepAt = 1024;

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    return this.consumeSync(nonce, expiresAt);
  }

  /**
   * The same decision without the promise. JavaScript runs it to completion,
   * so within one process it is atomic. `now` is injectable for tests.
   */
  consumeSync(nonce: string, expiresAt: number, now = Date.now()): boolean {
    if (this.spent.size >= this.sweepAt) this.sweep(now);
    const spentUntil = this.spent.get(nonce);
    // A record past its own expiry binds nothing: the token it refers to fails
    // verification on its own, so holding the nonce would only grow the map.
    if (spentUntil !== undefined && spentUntil > now) return false;
    this.spent.set(nonce, expiresAt);
    return true;
  }

  get size(): number {
    return this.spent.size;
  }

  private sweep(now: number) {
    for (const [nonce, expiresAt] of this.spent) {
      if (expiresAt <= now) this.spent.delete(nonce);
    }
    this.sweepAt = Math.max(1024, this.spent.size * 2);
  }
}

/** The slice of Bun's `RedisClient` this store needs: `send(command, args)`. */
export interface NonceRedisClient {
  send(command: string, args: string[]): Promise<any>;
}

export interface RedisNonceStoreOptions {
  /**
   * Client to run against. Defaults to the app's shared client from
   * `RedisServiceProvider`, resolved on first use so constructing the store
   * never needs a kernel or a connection.
   */
  client?: NonceRedisClient;
  /** Key namespace. Defaults to `gemi:ai:nonce`. */
  prefix?: string;
}

/**
 * Spent nonces in Redis, shared by every instance of the app. `SET ... NX` is
 * a single command, so the insert-if-absent is atomic in Redis; `PX` hands the
 * cleanup to Redis at the token's own expiry.
 *
 * ```ts
 * const nonces = new RedisNonceStore();
 *
 * class ChatController extends AgentController<typeof chat> {
 *   agent = chat;
 *   nonces = nonces;
 * }
 * ```
 *
 * A Redis failure rejects, and the answer it was checking is refused (see
 * `NonceStore.consume`).
 */
export class RedisNonceStore implements NonceStore {
  private readonly injectedClient?: NonceRedisClient;
  private readonly prefix: string;

  constructor(options: RedisNonceStoreOptions = {}) {
    this.injectedClient = options.client;
    this.prefix = options.prefix ?? "gemi:ai:nonce";
  }

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    // At least 1ms: `PX 0` is an error, and an already-expired token never
    // reaches here (verification refuses it first) unless the clock moved.
    const ttl = Math.max(1, Math.ceil(expiresAt - Date.now()));
    const reply = await this.client.send("SET", [
      `${this.prefix}:${nonce}`,
      "1",
      "PX",
      String(ttl),
      "NX",
    ]);
    // `OK` when the key was set, nil when it already existed.
    return reply === "OK";
  }

  private get client(): NonceRedisClient {
    if (this.injectedClient) return this.injectedClient;
    const container = app();
    const client = container.bound(RedisManager)
      ? container.make(RedisManager).client
      : undefined;
    if (!client) {
      throw new Error(
        "RedisNonceStore could not reach the Redis client. Register RedisServiceProvider on your application, or pass a client: new RedisNonceStore({ client }).",
      );
    }
    return client;
  }
}

/**
 * The slice of a model a `PrismaNonceStore` writes to: a Prisma client's
 * delegate (`prisma.mcpOAuthUse`) or a gemi ORM model class (`McpOAuthUse`).
 * Rows are `{ key: string; expiresAt: Date }`, `key` the primary key.
 */
export interface NonceModel {
  create(args: { data: { key: string; expiresAt: Date } }): PromiseLike<unknown>;
  deleteMany(args: { where: Record<string, unknown> }): PromiseLike<{ count: number }>;
}

export interface PrismaNonceStoreOptions {
  /**
   * Put in front of every nonce, so a table shared with other single-use keys
   * (`McpOAuthUse`, whose keys are SHA-256 hex) cannot collide with them.
   * Default `""`.
   */
  prefix?: string;
}

/**
 * Spent nonces in a table of the app's database, shared by every instance
 * that shares the database: for an app with no Redis. Spending is an
 * `INSERT` of the nonce as the primary key, so the database settles a race:
 * of two instances handed the same answer, one insert goes in and the other
 * hits the key and is told "already spent".
 *
 * ```prisma
 * model McpOAuthUse {
 *   key       String   @id
 *   expiresAt DateTime
 * }
 * ```
 *
 * ```ts
 * const nonces = new PrismaNonceStore(McpOAuthUse, { prefix: "nonce:" }); // gemi ORM model
 * const nonces = new PrismaNonceStore(prisma.mcpOAuthUse, { prefix: "nonce:" }); // Prisma client
 * ```
 *
 * A row past its `expiresAt` binds nothing (the token it was spent for fails
 * verification on its own), so `prune()` deletes them; run it from a
 * scheduled job. A failing database rejects, and the answer is refused (see
 * `NonceStore.consume`).
 */
export class PrismaNonceStore implements NonceStore {
  private readonly prefix: string;

  constructor(
    private readonly model: NonceModel,
    options: PrismaNonceStoreOptions = {},
  ) {
    if (typeof model?.create !== "function" || typeof model.deleteMany !== "function") {
      throw new Error(
        "PrismaNonceStore needs a model with create() and deleteMany(): a gemi ORM model class or a Prisma client's delegate, like prisma.mcpOAuthUse.",
      );
    }
    this.prefix = options.prefix ?? "";
  }

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    const key = this.prefix + nonce;
    if (await this.insert(key, expiresAt)) return true;
    // A row left over past its expiry (not pruned yet) binds nothing. Deleting
    // it is guarded by its expiry, so of two racers at most one deletes it,
    // and the primary key still lets only one insert in.
    const { count } = await this.model.deleteMany({
      where: { key, expiresAt: { lte: new Date() } },
    });
    return count > 0 && (await this.insert(key, expiresAt));
  }

  /** Deletes the nonces that have expired, and resolves to how many. */
  async prune(now = Date.now()): Promise<number> {
    const where: Record<string, unknown> = { expiresAt: { lte: new Date(now) } };
    if (this.prefix !== "") where.key = { startsWith: this.prefix };
    const { count } = await this.model.deleteMany({ where });
    return count;
  }

  private async insert(key: string, expiresAt: number): Promise<boolean> {
    try {
      await this.model.create({ data: { key, expiresAt: new Date(expiresAt) } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

/**
 * A write refused by a unique key: gemi ORM's `UniqueConstraintError`, or
 * Prisma's `P2002` for an app whose models are a Prisma client. The Prisma
 * code is recognised here, inside a store written for both, and is not part
 * of gemi's public surface (see `UniqueConstraintError`).
 */
export function isUniqueViolation(error: unknown): boolean {
  if (isUniqueConstraintError(error)) return true;
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** The process-wide default, shared by every agent that is not given a store. */
export const defaultNonceStore = new MemoryNonceStore();
