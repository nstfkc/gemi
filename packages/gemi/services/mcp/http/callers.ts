import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { User } from "../../../auth/types";
import type { McpRegistry, McpRemotePrincipal } from "../McpRegistry";

/**
 * What a caller resolver is told about the server it resolves for.
 */
export type McpResolveContext = {
  /**
   * The MCP endpoint's canonical URL, from config — the OAuth `resource` and
   * the audience a token must have been issued for. Never read off the
   * request: a `Host` header is the client's to write.
   */
  resource: string;
  /** The tools, and the scopes that reach them. */
  registry: McpRegistry;
};

/**
 * What a resolver made of a request's credential.
 *
 * `invalid_token` answers 401: missing, malformed, expired, revoked, or
 * issued for another audience. The description is sent to the client in the
 * `WWW-Authenticate` header, so it says what is wrong with the credential and
 * never anything about the user or the store.
 */
export type McpResolution =
  | { ok: true; principal: McpRemotePrincipal }
  | { ok: false; error: "invalid_token"; description: string };

/**
 * Turns the credential on a request to the MCP endpoint into a principal: the
 * user every tool call runs as, and the scopes that decide which tools they
 * see. The transport refuses to start without one, and the request is
 * answered 401 unless one of them resolves it.
 *
 * Resolvers are asked in order. One that answers `null` does not recognise the
 * credential (or there is none) and the next is asked; one that answers a
 * refusal ends the request, so a token one resolver issued and revoked cannot
 * be retried against another.
 *
 * A resolver builds the principal from a credential it *verified* — looked up,
 * checked against its audience and expiry — and never from anything else the
 * request says. The principal's user is put on every dispatched route's
 * request context as a signed-in user would be; a resolver that believed a
 * header would sign anybody in as anybody.
 */
export interface McpCallerResolver {
  /** Recorded as `principal.via`, and `req.mcpGrant().via`. */
  readonly name: string;
  resolve(req: Request, context: McpResolveContext): Promise<McpResolution | null>;
  /**
   * The `WWW-Authenticate` value for a request no resolver claimed, so a
   * client knows how to get a credential. The first resolver that has one is
   * used.
   */
  challenge?(context: McpResolveContext, options?: { scope?: string[] }): string | null;
  /**
   * HTTP endpoints of the resolver's own — an OAuth authorization server's
   * metadata, registration, authorize and token endpoints. Asked before the
   * MCP endpoint, for every request to the configured origin. `null` passes.
   */
  handle?(req: Request, context: McpResolveContext): Promise<Response | null>;
  /** Called once, when the transport is built: a place to refuse a bad config at boot. */
  boot?(context: McpResolveContext): void;
}

/** The bearer token on a request, or `null`. Never anything from the query string. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+([\x21-\x7e]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** What `McpApiKeyResolver`'s `verify` answers for a key it knows. */
export type McpApiKey = {
  /** The user the key acts as. */
  user: User;
  /** The key's own id (a row id), never the key: it keys rate limits and logs. */
  id: string;
  /** The scopes the key carries; see `McpRouter.scopes`. */
  scopes: readonly string[];
};

export type McpApiKeyResolverOptions = {
  /**
   * The prefix every key of this app starts with, like `"kyte_mcp_"`.
   * Required: a bearer token without it is left for the next resolver (an
   * OAuth access token), and a key is never looked up by a resolver that did
   * not issue it. Also what makes a leaked key recognisable to a secret
   * scanner.
   */
  prefix: string;
  /**
   * Looks the key up. Store keys hashed — `McpApiKeyResolver.hash(key)` — and
   * look up by the hash, so a database read is not a list of working keys.
   * Answer `null` for an unknown, expired or revoked key.
   */
  verify(key: string, req: Request): Promise<McpApiKey | null>;
};

/**
 * Remote callers authenticated by an API key the app issued: a user creates
 * one in the app's settings and pastes it into an MCP client as a bearer
 * token. Simpler than OAuth, for clients configured by hand (Claude Code,
 * scripts); a hosted client such as Claude.ai's connectors uses OAuth.
 *
 * ```ts
 * remote: {
 *   enabled: true,
 *   url: "https://example.com/mcp",
 *   resolvers: [
 *     new McpApiKeyResolver({
 *       prefix: "ex_mcp_",
 *       verify: async (key) => {
 *         const row = await ApiKey.findFirst({ where: { hash: McpApiKeyResolver.hash(key), revokedAt: null }, include: { user: true } });
 *         return row && { user: row.user, id: row.publicId, scopes: row.scopes };
 *       },
 *     }),
 *   ],
 * }
 * ```
 */
export class McpApiKeyResolver implements McpCallerResolver {
  readonly name = "api-key";

  constructor(private readonly options: McpApiKeyResolverOptions) {
    if (typeof options?.prefix !== "string" || !/^[A-Za-z0-9_-]{3,32}$/.test(options.prefix)) {
      throw new Error(
        "McpApiKeyResolver: prefix is required: 3 to 32 letters, digits, _ or -, like \"myapp_mcp_\".",
      );
    }
    if (typeof options.verify !== "function") {
      throw new Error("McpApiKeyResolver: verify must be a function that looks a key up.");
    }
  }

  /** A new key: the prefix and 32 random bytes, base64url. Show it once, store its hash. */
  static generate(prefix: string): string {
    return `${prefix}${randomBytes(32).toString("base64url")}`;
  }

  /** What to store for a key and look it up by: SHA-256, hex. */
  static hash(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  /** Compares two hashes without leaking where they differ. */
  static hashesMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async resolve(req: Request): Promise<McpResolution | null> {
    const token = bearerToken(req);
    if (!token?.startsWith(this.options.prefix)) return null;
    const key = await this.options.verify(token, req);
    if (!key) {
      return { ok: false, error: "invalid_token", description: "The API key is not valid." };
    }
    if (!key.user || typeof key.id !== "string" || key.id === "" || !Array.isArray(key.scopes)) {
      throw new Error(
        "McpApiKeyResolver: verify must answer { user, id, scopes } for a key it knows, or null.",
      );
    }
    return {
      ok: true,
      principal: { user: key.user, via: this.name, id: key.id, scopes: [...key.scopes] },
    };
  }

  challenge(): string {
    return 'Bearer realm="mcp"';
  }
}
