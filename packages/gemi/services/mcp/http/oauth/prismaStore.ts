import { PrismaNonceStore, type NonceModel } from "../../../../ai/store/Nonces";
import type {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthStore,
  McpOAuthToken,
  McpOAuthTokenEndpointAuthMethod,
} from "./store";

/**
 * The slice of a model `PrismaMcpOAuthStore` uses: a Prisma client's delegate
 * (`prisma.mcpOAuthCredential`) or a gemi ORM model class
 * (`McpOAuthCredential`). Both answer these with Prisma's arguments.
 */
export interface McpOAuthModel {
  create(args: any): PromiseLike<unknown>;
  findUnique(args: any): PromiseLike<any>;
  findFirst(args: any): PromiseLike<any>;
  findMany(args: any): PromiseLike<any[]>;
  count(args: any): PromiseLike<number>;
  updateMany(args: any): PromiseLike<{ count: number }>;
  deleteMany(args: any): PromiseLike<{ count: number }>;
}

export type PrismaMcpOAuthStoreModels = {
  /** `McpOAuthClient`: the clients that registered. */
  clients: Pick<McpOAuthModel, "create" | "findUnique" | "findMany">;
  /** `McpOAuthCredential`: codes, access and refresh tokens, by their SHA-256. */
  credentials: McpOAuthModel;
  /** `McpOAuthUse`: single-use keys spent (codes, refresh tokens, consent decisions). */
  uses: NonceModel;
};

/** A grant to one connected app, as a "Connected apps" screen lists it. */
export type McpOAuthConnectedApp = {
  /** The grant: what `disconnect` revokes, and `req.mcpGrant().id` on its calls. */
  familyId: string;
  clientId: string;
  /** What the client called itself when it registered: unverified. */
  clientName: string | null;
  clientUri: string | null;
  scopes: string[];
  /** When the grant's oldest live refresh token was issued. */
  connectedAt: Date;
};

/**
 * `McpOAuthStore` on three tables of the app's database, shared by every
 * instance. Pass the models: gemi ORM model classes, or a Prisma client's
 * delegates.
 *
 * ```ts
 * new PrismaMcpOAuthStore({ clients: McpOAuthClient, credentials: McpOAuthCredential, uses: McpOAuthUse });
 * new PrismaMcpOAuthStore({ clients: prisma.mcpOAuthClient, credentials: prisma.mcpOAuthCredential, uses: prisma.mcpOAuthUse });
 * ```
 *
 * The models are in `docs/mcp.md` ("The store"). Every code and token is a
 * row of `McpOAuthCredential`, kept as its SHA-256. A family (one user's
 * grant to one client) is revoked by stamping `revokedAt` on its rows, and a
 * family with any revoked row is revoked: so a token saved after the
 * revocation (a refresh racing it) is refused too, and `prune` keeps a
 * revoked family's rows while any of its rows could still be used.
 *
 * Besides the store, it answers what an app's settings need: the user's
 * `connectedApps`, `disconnect` one, `revokeUser` (all of a user's grants,
 * when their role changes), `prune` (from a scheduled job), and `nonces()`,
 * a `NonceStore` for `route.mcp.remote.nonces` on the same `McpOAuthUse`
 * table.
 */
export class PrismaMcpOAuthStore implements McpOAuthStore {
  private readonly clients: PrismaMcpOAuthStoreModels["clients"];
  private readonly credentials: McpOAuthModel;
  private readonly uses: PrismaNonceStore;
  private readonly usesModel: NonceModel;

  constructor(models: PrismaMcpOAuthStoreModels) {
    for (const [name, methods] of [
      ["clients", ["create", "findUnique", "findMany"]],
      ["credentials", ["create", "findFirst", "findMany", "count", "updateMany", "deleteMany"]],
      ["uses", ["create", "deleteMany"]],
    ] as const) {
      const model = (models as Record<string, any> | undefined)?.[name];
      const missing = methods.filter((method) => typeof model?.[method] !== "function");
      if (missing.length > 0) {
        throw new Error(
          `PrismaMcpOAuthStore: models.${name} must be a gemi ORM model or a Prisma delegate (it has no ${missing.join(", ")}()).`,
        );
      }
    }
    this.clients = models.clients;
    this.credentials = models.credentials;
    this.usesModel = models.uses;
    // Spent codes and refresh tokens are kept under their hash as is.
    this.uses = new PrismaNonceStore(models.uses);
  }

  // --- McpOAuthStore ----------------------------------------------------------

  async createClient(client: McpOAuthClient) {
    await this.clients.create({
      data: {
        clientId: client.clientId,
        clientSecretHash: client.clientSecretHash,
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        redirectUris: [...client.redirectUris],
        clientName: client.clientName,
        clientUri: client.clientUri,
        createdAt: new Date(client.createdAt),
      },
    });
  }

  async findClient(clientId: string): Promise<McpOAuthClient | null> {
    const row = await this.clients.findUnique({ where: { clientId } });
    if (!row) return null;
    return {
      clientId: row.clientId,
      clientSecretHash: row.clientSecretHash ?? null,
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as McpOAuthTokenEndpointAuthMethod,
      redirectUris: strings(row.redirectUris),
      clientName: row.clientName ?? null,
      clientUri: row.clientUri ?? null,
      createdAt: time(row.createdAt),
    };
  }

  async saveCode(code: McpOAuthCode) {
    await this.credentials.create({
      data: {
        hash: code.hash,
        kind: "code",
        clientId: code.clientId,
        userId: code.userId,
        scopes: [...code.scopes],
        resource: code.resource,
        familyId: code.familyId,
        redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge,
        expiresAt: new Date(code.expiresAt),
      },
    });
  }

  async findCode(hash: string): Promise<McpOAuthCode | null> {
    const row = await this.findLive(hash, ["code"]);
    if (!row || row.redirectUri == null || row.codeChallenge == null) return null;
    return {
      hash: row.hash,
      clientId: row.clientId,
      userId: row.userId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      scopes: strings(row.scopes),
      resource: row.resource,
      familyId: row.familyId,
      expiresAt: time(row.expiresAt),
    };
  }

  async saveToken(token: McpOAuthToken) {
    await this.credentials.create({
      data: {
        hash: token.hash,
        kind: token.kind,
        clientId: token.clientId,
        userId: token.userId,
        scopes: [...token.scopes],
        resource: token.resource,
        familyId: token.familyId,
        expiresAt: new Date(token.expiresAt),
      },
    });
  }

  async findToken(hash: string): Promise<McpOAuthToken | null> {
    const row = await this.findLive(hash, ["access", "refresh"]);
    if (!row) return null;
    return {
      hash: row.hash,
      kind: row.kind as McpOAuthToken["kind"],
      clientId: row.clientId,
      userId: row.userId,
      scopes: strings(row.scopes),
      resource: row.resource,
      familyId: row.familyId,
      expiresAt: time(row.expiresAt),
    };
  }

  use(hash: string, expiresAt: number) {
    return this.uses.consume(hash, expiresAt);
  }

  async revokeFamily(familyId: string) {
    await this.credentials.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // --- for the app ------------------------------------------------------------

  /**
   * A `NonceStore` on the same `McpOAuthUse` table, for
   * `route.mcp.remote.nonces`: approvals spent once across every instance.
   * Its keys carry `prefix` (default `"nonce:"`), so they never collide with
   * the hashes the OAuth server spends there.
   */
  nonces(options: { prefix?: string } = {}): PrismaNonceStore {
    return new PrismaNonceStore(this.usesModel, { prefix: options.prefix ?? "nonce:" });
  }

  /**
   * The user's grants that can still be used, newest first: one per family
   * with a refresh token that has neither expired nor been revoked.
   */
  async connectedApps(userId: string | number, now = new Date()): Promise<McpOAuthConnectedApp[]> {
    const user = String(userId);
    const rows = await this.credentials.findMany({
      where: { userId: user, kind: "refresh", expiresAt: { gt: now } },
      orderBy: { createdAt: "asc" },
    });
    const revoked = await this.revokedFamilies({ userId: user });
    const families = new Map<string, any>();
    for (const row of rows) {
      if (revoked.has(row.familyId)) continue;
      // A family's oldest live refresh token dates it (refresh tokens rotate).
      if (!families.has(row.familyId)) families.set(row.familyId, row);
    }
    if (families.size === 0) return [];
    const clientIds = [...new Set([...families.values()].map((row) => row.clientId as string))];
    const clients = await this.clients.findMany({ where: { clientId: { in: clientIds } } });
    const byId = new Map<string, any>(clients.map((client: any) => [client.clientId, client]));
    return [...families.values()]
      .map((row) => ({
        familyId: row.familyId as string,
        clientId: row.clientId as string,
        clientName: byId.get(row.clientId)?.clientName ?? null,
        clientUri: byId.get(row.clientId)?.clientUri ?? null,
        scopes: strings(row.scopes),
        connectedAt: new Date(time(row.createdAt)),
      }))
      .reverse();
  }

  /** Revokes one of the user's grants. `false` when the grant is not theirs. */
  async disconnect(userId: string | number, familyId: string): Promise<boolean> {
    const owned = await this.credentials.count({ where: { familyId, userId: String(userId) } });
    if (owned === 0) return false;
    await this.revokeFamily(familyId);
    return true;
  }

  /**
   * Revokes every grant the user has, for every client: when they are
   * deleted, signed out everywhere, or lose the role the tools need. Their
   * clients have to connect again.
   */
  async revokeUser(userId: string | number): Promise<void> {
    await this.credentials.updateMany({
      where: { userId: String(userId), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Deletes what can no longer be used: codes and tokens a day past their
   * expiry, and spent keys past theirs. A revoked family's revoked rows are
   * what keeps it revoked, so they stay while any row of that family has not
   * expired: a token a refresh saved as the grant was revoked would otherwise
   * come back to life once the older revoked rows were gone.
   */
  async prune(now = Date.now()): Promise<void> {
    const before = new Date(now - 24 * 60 * 60_000);
    const revoked = [...(await this.revokedFamilies({ expiresAt: { lt: before } }))];
    const live =
      revoked.length === 0
        ? []
        : await this.credentials.findMany({
            where: { familyId: { in: revoked }, expiresAt: { gte: before } },
            select: { familyId: true },
          });
    const keep = [...new Set(live.map((row: any) => row.familyId as string))];
    await this.credentials.deleteMany({
      where: {
        expiresAt: { lt: before },
        ...(keep.length > 0 ? { OR: [{ revokedAt: null }, { familyId: { notIn: keep } }] } : {}),
      },
    });
    await this.usesModel.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  }

  // --- internals --------------------------------------------------------------

  /** A code or token, unless its family has a revoked row. */
  private async findLive(hash: string, kinds: string[]) {
    const row = await this.credentials.findFirst({
      where: { hash, kind: { in: kinds }, revokedAt: null },
    });
    if (!row) return null;
    const revoked = await this.credentials.count({
      where: { familyId: row.familyId, revokedAt: { not: null } },
    });
    return revoked > 0 ? null : row;
  }

  private async revokedFamilies(where: Record<string, unknown>): Promise<Set<string>> {
    const rows = await this.credentials.findMany({
      where: { ...where, revokedAt: { not: null } },
      select: { familyId: true },
    });
    return new Set(rows.map((row: any) => row.familyId as string));
  }
}

/** A `String[]` column, or a `Json` one on a database without lists. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function time(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
}
