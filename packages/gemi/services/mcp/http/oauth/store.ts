/**
 * What `McpOAuthServer` keeps: the clients that registered, the authorization
 * codes it handed out, and the tokens it issued.
 *
 * No secret is stored. A client secret, a code and a token are kept as their
 * SHA-256 (`hash`), and looked up by it, so a read of the store is not a list
 * of working credentials.
 *
 * Every code and token belongs to a *family*: one user's consent to one client.
 * The family is what a refresh rotates within, what a replayed code or refresh
 * token revokes, and what an app's "connected apps" screen lists and revokes.
 */
export interface McpOAuthStore {
  createClient(client: McpOAuthClient): Promise<void>;
  findClient(clientId: string): Promise<McpOAuthClient | null>;

  saveCode(code: McpOAuthCode): Promise<void>;
  findCode(hash: string): Promise<McpOAuthCode | null>;

  saveToken(token: McpOAuthToken): Promise<void>;
  /** The token with this hash, or `null` when there is none or its family was revoked. */
  findToken(hash: string): Promise<McpOAuthToken | null>;

  /**
   * Spends a single-use credential (a code, a refresh token): `true` when this
   * call is the one that spent it, `false` when it was already spent. Must be
   * atomic across every process sharing the store — two exchanges of one code
   * racing must not both win. Kept until `expiresAt` (epoch ms).
   */
  use(hash: string, expiresAt: number): Promise<boolean>;

  /** Revokes every code and token of a family. Idempotent. */
  revokeFamily(familyId: string): Promise<void>;
}

export type McpOAuthTokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export type McpOAuthClient = {
  clientId: string;
  /** SHA-256 hex of the secret, for a confidential client; `null` for a public one. */
  clientSecretHash: string | null;
  tokenEndpointAuthMethod: McpOAuthTokenEndpointAuthMethod;
  redirectUris: string[];
  /** What the client calls itself: unverified, shown on the consent screen as such. */
  clientName: string | null;
  clientUri: string | null;
  /** Epoch ms. */
  createdAt: number;
};

export type McpOAuthCode = {
  hash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  /** The S256 PKCE challenge the code is redeemed against. */
  codeChallenge: string;
  scopes: string[];
  /** The resource (audience) the tokens will be for. */
  resource: string;
  familyId: string;
  /** Epoch ms. */
  expiresAt: number;
};

export type McpOAuthToken = {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  scopes: string[];
  /** The audience: the MCP endpoint's URL. A token is accepted nowhere else. */
  resource: string;
  familyId: string;
  /** Epoch ms. */
  expiresAt: number;
};

/**
 * `McpOAuthStore` in this process's memory: for development, tests, and an
 * app with one instance that accepts every connection being lost on a
 * restart. With more than one instance use a shared store (a database), or a
 * token issued by one instance is unknown to the next.
 */
export class MemoryMcpOAuthStore implements McpOAuthStore {
  private readonly clients = new Map<string, McpOAuthClient>();
  private readonly codes = new Map<string, McpOAuthCode>();
  private readonly tokens = new Map<string, McpOAuthToken>();
  private readonly used = new Map<string, number>();
  private readonly revoked = new Set<string>();

  async createClient(client: McpOAuthClient) {
    this.clients.set(client.clientId, structuredClone(client));
  }

  async findClient(clientId: string) {
    const client = this.clients.get(clientId);
    return client ? structuredClone(client) : null;
  }

  async saveCode(code: McpOAuthCode) {
    this.sweep();
    this.codes.set(code.hash, structuredClone(code));
  }

  async findCode(hash: string) {
    const code = this.codes.get(hash);
    return code && !this.revoked.has(code.familyId) ? structuredClone(code) : null;
  }

  async saveToken(token: McpOAuthToken) {
    this.sweep();
    this.tokens.set(token.hash, structuredClone(token));
  }

  async findToken(hash: string) {
    const token = this.tokens.get(hash);
    return token && !this.revoked.has(token.familyId) ? structuredClone(token) : null;
  }

  async use(hash: string, expiresAt: number) {
    if (this.used.has(hash)) return false;
    this.used.set(hash, expiresAt);
    return true;
  }

  async revokeFamily(familyId: string) {
    this.revoked.add(familyId);
    for (const [hash, token] of this.tokens) if (token.familyId === familyId) this.tokens.delete(hash);
    for (const [hash, code] of this.codes) if (code.familyId === familyId) this.codes.delete(hash);
  }

  /** Every family a user has, for a "connected apps" screen. */
  async families(userId: string): Promise<{ familyId: string; clientId: string; scopes: string[] }[]> {
    const seen = new Map<string, { familyId: string; clientId: string; scopes: string[] }>();
    for (const token of this.tokens.values()) {
      if (token.userId === userId && !this.revoked.has(token.familyId) && token.expiresAt > Date.now()) {
        seen.set(token.familyId, { familyId: token.familyId, clientId: token.clientId, scopes: [...token.scopes] });
      }
    }
    return [...seen.values()];
  }

  private sweep(now = Date.now()) {
    for (const [hash, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(hash);
    for (const [hash, token] of this.tokens) if (token.expiresAt <= now) this.tokens.delete(hash);
    for (const [hash, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(hash);
  }
}
