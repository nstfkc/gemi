import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AuthManager } from "../../../../auth/AuthManager";
import { sessionUser } from "../../../../auth/accessToken";
import type { User } from "../../../../auth/types";
import { app } from "../../../../foundation/app";
import { HttpRequest } from "../../../../http/HttpRequest";
import { clientIp } from "../../../../http/RateLimitMiddleware";
import { bearerToken, type McpCallerResolver, type McpResolution, type McpResolveContext } from "../callers";
import { overBudget, type Budget } from "../limits";
import { sign, verify } from "../signedState";
import { CONSENT_PAGE_HEADERS, consentPage, errorPage } from "./consentPage";
import type {
  McpOAuthClient,
  McpOAuthStore,
  McpOAuthToken,
  McpOAuthTokenEndpointAuthMethod,
} from "./store";

export type McpOAuthServerOptions = {
  /** Where clients, codes and tokens are kept. `MemoryMcpOAuthStore` for one process; a database for more. */
  store: McpOAuthStore;
  /**
   * Loads the user a token was issued to, by the id it was issued under
   * (`String(user.id)`), on every request: a deleted user's tokens stop
   * working, and routes see the user as they are now. Answer the same shape a
   * signed-in request's `req.ctx().user` has.
   */
  findUser(id: string): Promise<User | null>;
  /**
   * The app's own consent page: a view (behind `auth`) that the browser is
   * sent to as `<consentPath>?request=…`. It calls `consent(request, user)`
   * and renders what that answers — the client, the scopes, and a form to
   * post. Without it gemi serves a plain page of its own.
   */
  consentPath?: string;
  /** Where a signed-out user is sent from gemi's own consent page. Default: `auth.signInPath`. */
  signInPath?: string;
  /** The app's name on gemi's own consent page. Default: the endpoint's host. */
  appName?: string;
  /** How the signed-in user is named on the consent page. Default: email, name, or id. */
  userLabel?(user: User): string;
  /** Access token lifetime, in seconds. Default one hour. */
  accessTokenTtl?: number;
  /** Refresh token lifetime, in seconds; each refresh rotates it. Default 30 days. */
  refreshTokenTtl?: number;
  /**
   * Dynamic client registration (RFC 7591), which is how MCP clients
   * (Claude, the Inspector) register themselves. On by default; `false`
   * turns the endpoint off, for an app that registers its clients itself.
   */
  registration?:
    | false
    | {
        /** Registrations per client address. Default 20 an hour. */
        rateLimit?: Budget;
        /**
         * Narrows which redirect URIs a client may register, beyond gemi's
         * own rule (https, or http on a loopback address). Answer `false` to
         * refuse one — to allow only the clients you know, say.
         */
        allowRedirectUri?(uri: URL): boolean;
      };
};

/** What the consent page shows and posts, from `McpOAuthServer.consent`. */
export type McpConsent = {
  client: {
    id: string;
    /** What the client calls itself. Unverified: show it as such. */
    name: string | null;
    /** The host the user will be sent to after deciding — the one fact about the client that is verified. */
    redirectHost: string;
  };
  scopes: { name: string; description: string }[];
  user: { id: string; label: string };
  /** The form to render: post `fields` and `decision=allow` or `decision=deny` to `action`. */
  form: { action: string; method: "POST"; fields: { request: string; csrf: string } };
};

const ACCESS_PREFIX = "gmcp_at_";
const REFRESH_PREFIX = "gmcp_rt_";
const CODE_PREFIX = "gmcp_ac_";
const CLIENT_PREFIX = "gmcp_c_";
const SECRET_PREFIX = "gmcp_cs_";

const TICKET = "gemi.mcp.oauth.ticket.v1";
const CSRF = "gemi.mcp.oauth.consent.v1";
const TICKET_TTL = 10 * 60 * 1000;
const CODE_TTL = 2 * 60 * 1000;
const MAX_FORM_BYTES = 16 * 1024;
const DEFAULT_REGISTRATION_BUDGET: Budget = { limit: 20, window: 60 * 60 };
const TOKEN_BUDGET: Budget = { limit: 60, window: 60 };
const AUTH_METHODS: readonly McpOAuthTokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

/** An authorization request, signed and handed to the browser between `authorize` and the decision. */
type Ticket = {
  c: string;
  r: string;
  s: string[];
  cc: string;
  st: string | null;
  n: string;
  exp: number;
};

type ConsentToken = { t: string; u: string; exp: number };

class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly headers: Record<string, string> = {},
  ) {
    super(description);
  }
}

/**
 * An OAuth 2.1 authorization server for the MCP endpoint, and the resolver
 * for the tokens it issues: what lets a hosted MCP client (Claude.ai's
 * connectors) act for a user who signed in and agreed (#762).
 *
 * - Discovery: protected resource metadata (RFC 9728) and authorization
 *   server metadata (RFC 8414). `WWW-Authenticate` on a 401 points at them.
 * - Dynamic client registration (RFC 7591).
 * - Authorization code with PKCE (S256 only), consent by the signed-in user
 *   on a page that cannot be framed, with a CSRF token bound to the request
 *   and the user, `iss` in the response (RFC 9207).
 * - Tokens are opaque, stored hashed, and bound to the endpoint as their
 *   audience (RFC 8707). Refresh tokens rotate; a replayed one, like a
 *   replayed code, revokes the whole grant. Revocation (RFC 7009).
 *
 * The endpoints live under the MCP endpoint's path (`/mcp/oauth/…`) and the
 * metadata at the origin's `/.well-known/…`, all on the configured host
 * only.
 */
export class McpOAuthServer implements McpCallerResolver {
  readonly name = "oauth";
  private context!: McpResolveContext;
  private issuer!: string;
  private base!: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(private readonly options: McpOAuthServerOptions) {
    const store = options?.store;
    for (const method of ["createClient", "findClient", "saveCode", "findCode", "saveToken", "findToken", "use", "revokeFamily"] as const) {
      if (typeof store?.[method] !== "function") {
        throw new Error(`McpOAuthServer: store.${method} is missing. Use MemoryMcpOAuthStore, or implement McpOAuthStore.`);
      }
    }
    if (typeof options.findUser !== "function") {
      throw new Error("McpOAuthServer: findUser(id) is required: it loads the user a token was issued to.");
    }
    if (options.consentPath !== undefined && !/^\/[^/\\]/.test(options.consentPath)) {
      throw new Error('McpOAuthServer: consentPath must be a path on this app, like "/oauth/consent".');
    }
    this.accessTtl = seconds("accessTokenTtl", options.accessTokenTtl, 60 * 60);
    this.refreshTtl = seconds("refreshTokenTtl", options.refreshTokenTtl, 30 * 24 * 60 * 60);
  }

  get store(): McpOAuthStore {
    return this.options.store;
  }

  boot(context: McpResolveContext) {
    this.context = context;
    const url = new URL(context.resource);
    this.issuer = url.origin;
    this.base = `${url.pathname}/oauth`;
  }

  // --- the resource server ---------------------------------------------------

  async resolve(req: Request): Promise<McpResolution | null> {
    const token = bearerToken(req);
    if (!token?.startsWith(ACCESS_PREFIX)) return null;
    const record = await this.store.findToken(hash(token));
    const invalid = (description: string) => ({ ok: false as const, error: "invalid_token" as const, description });
    if (!record || record.kind !== "access") return invalid("The access token is not valid.");
    if (record.expiresAt <= Date.now()) return invalid("The access token expired.");
    // Audience: a token issued for another resource — another app's MCP
    // endpoint sharing this store, or a later URL — is not accepted here.
    if (record.resource !== this.context.resource) return invalid("The access token was not issued for this server.");
    const user = await this.options.findUser(record.userId);
    if (!user) return invalid("The access token is not valid.");
    return {
      ok: true,
      principal: {
        user,
        via: this.name,
        id: record.familyId,
        scopes: record.scopes,
        clientId: record.clientId,
      },
    };
  }

  challenge(): string {
    const scopes = this.scopeNames().join(" ");
    return `Bearer resource_metadata="${this.resourceMetadataUrl()}", scope="${scopes}"`;
  }

  // --- the authorization server's endpoints ---------------------------------

  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    const endpoint = new URL(this.context.resource).pathname;
    const routes: Record<string, { methods: string[]; cors: boolean; run: () => Promise<Response> | Response }> = {
      [`/.well-known/oauth-protected-resource${endpoint}`]: { methods: ["GET"], cors: true, run: () => this.resourceMetadata() },
      ["/.well-known/oauth-protected-resource"]: { methods: ["GET"], cors: true, run: () => this.resourceMetadata() },
      ["/.well-known/oauth-authorization-server"]: { methods: ["GET"], cors: true, run: () => this.serverMetadata() },
      [`${this.base}/register`]: { methods: ["POST"], cors: true, run: () => this.register(req) },
      [`${this.base}/authorize`]: { methods: ["GET"], cors: false, run: () => this.authorize(req) },
      [`${this.base}/consent`]: {
        methods: ["GET", "POST"],
        cors: false,
        run: () => (req.method === "POST" ? this.decide(req) : this.consentScreen(req)),
      },
      [`${this.base}/token`]: { methods: ["POST"], cors: true, run: () => this.token(req) },
      [`${this.base}/revoke`]: { methods: ["POST"], cors: true, run: () => this.revoke(req) },
    };
    const route = routes[path];
    if (!route) return null;
    if (path === `${this.base}/register` && this.options.registration === false) return null;

    // Discovery, registration and the token endpoint are called by browser
    // clients (the Inspector) too. None of them reads a cookie, so any
    // origin may: what they answer depends only on what is sent.
    const cors = route.cors ? CORS_ANY : {};
    if (req.method === "OPTIONS" && route.cors) {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": route.methods.join(", "),
          "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (!route.methods.includes(req.method)) {
      return new Response(null, { status: 405, headers: { ...cors, Allow: route.methods.join(", ") } });
    }
    let response: Response;
    try {
      response = await route.run();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      response = json({ error: error.error, error_description: error.description }, error.status, error.headers);
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  }

  /**
   * The consent request a consent page was sent with, for the signed-in
   * `user`: what to show, and the form to post. `null` when the request is
   * not one this server made, has expired, or names a client that is gone —
   * render an error and offer no form.
   *
   * ```ts
   * // a view behind `auth`, at consentPath
   * const consent = await mcpOAuth.consent(req.search.get("request"), req.ctx().user);
   * ```
   */
  async consent(request: unknown, user: User | null | undefined): Promise<McpConsent | null> {
    if (!user) return null;
    const ticket = verify<Ticket>(TICKET, "gat1", request);
    if (!ticket) return null;
    const client = await this.store.findClient(ticket.c);
    if (!client || !client.redirectUris.some((uri) => redirectMatches(uri, ticket.r))) return null;
    const userId = String(user.id);
    const csrf = sign(CSRF, "gcs1", { t: digest(request as string), u: userId, exp: ticket.exp } satisfies ConsentToken);
    const described = new Map(this.context.registry.scopes().map((scope) => [scope.name, scope.description]));
    return {
      client: { id: client.clientId, name: client.clientName, redirectHost: new URL(ticket.r).host },
      scopes: ticket.s.map((name) => ({ name, description: described.get(name) ?? name })),
      user: { id: userId, label: this.userLabel(user) },
      form: {
        action: `${this.issuer}${this.base}/consent`,
        method: "POST",
        fields: { request: request as string, csrf },
      },
    };
  }

  private resourceMetadata(): Response {
    return json({
      resource: this.context.resource,
      authorization_servers: [this.issuer],
      scopes_supported: this.scopeNames(),
      bearer_methods_supported: ["header"],
    });
  }

  private serverMetadata(): Response {
    return json({
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}${this.base}/authorize`,
      token_endpoint: `${this.issuer}${this.base}/token`,
      ...(this.options.registration === false ? {} : { registration_endpoint: `${this.issuer}${this.base}/register` }),
      revocation_endpoint: `${this.issuer}${this.base}/revoke`,
      scopes_supported: this.scopeNames(),
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    });
  }

  // --- registration (RFC 7591) ----------------------------------------------

  private async register(req: Request): Promise<Response> {
    const registration = this.options.registration || {};
    const retryAfter = await overBudget(
      `mcp-oauth-register:${clientIp(new HttpRequest(req, {}, "api", `${this.base}/register`))}`,
      registration.rateLimit ?? DEFAULT_REGISTRATION_BUDGET,
    );
    if (retryAfter !== null) {
      throw new OAuthError("slow_down", "Too many registrations from this address.", 429, { "Retry-After": String(retryAfter) });
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
      throw new OAuthError("invalid_client_metadata", "Send the client metadata as application/json.");
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(await readLimited(req, MAX_FORM_BYTES));
    } catch {
      throw new OAuthError("invalid_client_metadata", "The client metadata is not JSON, or is too large.");
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new OAuthError("invalid_client_metadata", "The client metadata must be a JSON object.");
    }

    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must list one to ten URIs.");
    }
    for (const uri of redirectUris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new OAuthError("invalid_redirect_uri", `${String(uri).slice(0, 200)}: ${problem}`);
      if (registration.allowRedirectUri && registration.allowRedirectUri(new URL(uri as string)) !== true) {
        throw new OAuthError("invalid_redirect_uri", `${uri}: this server does not accept it.`);
      }
    }
    const method = (metadata.token_endpoint_auth_method ?? "client_secret_basic") as McpOAuthTokenEndpointAuthMethod;
    if (!AUTH_METHODS.includes(method)) {
      throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.`);
    }
    const grantTypes = metadata.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grantTypes) || grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token.");
    }
    const responseTypes = metadata.response_types ?? ["code"];
    if (!Array.isArray(responseTypes) || responseTypes.some((type) => type !== "code")) {
      throw new OAuthError("invalid_client_metadata", "response_types may only be code.");
    }
    const clientName = optionalText(metadata.client_name, 100, "client_name");
    const clientUri = optionalText(metadata.client_uri, 512, "client_uri");
    if (clientUri !== null && !isHttpsUrl(clientUri)) {
      throw new OAuthError("invalid_client_metadata", "client_uri must be an https URL.");
    }

    const secret = method === "none" ? null : `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const client: McpOAuthClient = {
      clientId: `${CLIENT_PREFIX}${randomBytes(16).toString("base64url")}`,
      clientSecretHash: secret ? hash(secret) : null,
      tokenEndpointAuthMethod: method,
      redirectUris: [...(redirectUris as string[])],
      clientName,
      clientUri,
      createdAt: Date.now(),
    };
    await this.store.createClient(client);
    return json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: method,
        grant_types: grantTypes,
        response_types: responseTypes,
        ...(clientName ? { client_name: clientName } : {}),
        ...(clientUri ? { client_uri: clientUri } : {}),
      },
      201,
    );
  }

  // --- authorization ---------------------------------------------------------

  private async authorize(req: Request): Promise<Response> {
    const query = new URL(req.url).searchParams;
    for (const key of new Set(query.keys())) {
      if (query.getAll(key).length > 1) return htmlError(`The parameter ${key} was sent more than once.`);
    }
    // Until the client and its redirect URI check out, nothing is sent
    // anywhere: an error redirect to an unchecked URI is an open redirect.
    const clientId = query.get("client_id");
    const client = clientId ? await this.store.findClient(clientId) : null;
    if (!client) return htmlError("The application is not registered with this server.");
    const requested = query.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
    if (!requested || !client.redirectUris.some((uri) => redirectMatches(uri, requested))) {
      return htmlError("The redirect URI is not one the application registered.");
    }
    const state = query.get("state");
    const fail = (error: string, description: string) => this.redirectBack(requested, state, { error, error_description: description });

    if (query.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = query.get("code_challenge");
    if (query.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256.");
    }
    const resource = query.get("resource");
    if (resource !== null && !sameResource(resource, this.context.resource)) {
      return fail("invalid_target", "The resource is not this server's.");
    }
    if (state !== null && state.length > 2048) return fail("invalid_request", "state is too long.");
    const known = this.scopeNames();
    const asked = query.get("scope");
    let scopes = known;
    if (asked !== null && asked.trim() !== "") {
      // Scopes this server does not know (openid, profile…) are left out,
      // which narrows the grant; asking only for those is an error.
      scopes = [...new Set(asked.split(" ").filter((scope) => known.includes(scope)))];
      if (scopes.length === 0) return fail("invalid_scope", "None of the requested scopes exist here.");
    }

    const ticket = sign(TICKET, "gat1", {
      c: client.clientId,
      r: requested,
      s: scopes,
      cc: challenge,
      st: state,
      n: randomBytes(16).toString("base64url"),
      exp: Date.now() + TICKET_TTL,
    } satisfies Ticket);
    const consent = this.options.consentPath ?? `${this.base}/consent`;
    return redirect(`${this.issuer}${consent}?request=${encodeURIComponent(ticket)}`, 302);
  }

  /** gemi's own consent page, for an app without a `consentPath`. */
  private async consentScreen(req: Request): Promise<Response> {
    const request = new URL(req.url).searchParams.get("request");
    const user = await this.sessionUser(req);
    if (!user) {
      const back = `${this.base}/consent?request=${encodeURIComponent(request ?? "")}`;
      const signIn = this.options.signInPath ?? app(AuthManager).config.signInPath;
      return redirect(`${signIn}${signIn.includes("?") ? "&" : "?"}redirect=${encodeURIComponent(back)}`, 302);
    }
    const consent = await this.consent(request, user);
    if (!consent) return htmlError("This authorization request has expired or is not valid. Start again from the application.");
    return new Response(consentPage(consent, { name: this.options.appName ?? new URL(this.issuer).host }), {
      status: 200,
      headers: CONSENT_PAGE_HEADERS,
    });
  }

  /**
   * The user's decision, posted from a consent page. Only from this origin
   * (`Origin`, or `Sec-Fetch-Site` when a browser sends no `Origin`), only by
   * the user the page was rendered for (the CSRF token is bound to them and
   * to the request), and only once.
   */
  private async decide(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    const sameOrigin = origin !== null ? origin === this.issuer : req.headers.get("sec-fetch-site") === "same-origin";
    if (!sameOrigin) return htmlError("This decision did not come from this site's consent page.", 403);
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
      return htmlError("The decision must be a form post.");
    }
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readLimited(req, MAX_FORM_BYTES));
    } catch {
      return htmlError("The decision is too large.");
    }
    const request = form.get("request");
    const ticket = verify<Ticket>(TICKET, "gat1", request);
    const csrf = verify<ConsentToken>(CSRF, "gcs1", form.get("csrf"));
    const user = await this.sessionUser(req);
    if (!ticket || !csrf || !user || csrf.t !== digest(request!) || csrf.u !== String(user.id)) {
      return htmlError("This authorization request has expired or is not valid. Start again from the application.", 403);
    }
    const client = await this.store.findClient(ticket.c);
    if (!client || !client.redirectUris.some((uri) => redirectMatches(uri, ticket.r))) {
      return htmlError("The application is not registered with this server.");
    }
    if (!(await this.store.use(`ticket:${ticket.n}`, ticket.exp))) {
      return htmlError("This request was already answered. Start again from the application.");
    }
    if (form.get("decision") !== "allow") {
      return this.redirectBack(ticket.r, ticket.st, { error: "access_denied", error_description: "The user denied the request." }, 303);
    }
    const code = `${CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
    await this.store.saveCode({
      hash: hash(code),
      clientId: client.clientId,
      userId: String(user.id),
      redirectUri: ticket.r,
      codeChallenge: ticket.cc,
      scopes: ticket.s,
      resource: this.context.resource,
      familyId: randomBytes(16).toString("base64url"),
      expiresAt: Date.now() + CODE_TTL,
    });
    return this.redirectBack(ticket.r, ticket.st, { code }, 303);
  }

  // --- tokens ----------------------------------------------------------------

  private async token(req: Request): Promise<Response> {
    const form = await readForm(req);
    const client = await this.authenticateClient(req, form);
    const retryAfter = await overBudget(`mcp-oauth-token:${client.clientId}`, TOKEN_BUDGET);
    if (retryAfter !== null) {
      throw new OAuthError("slow_down", "Too many token requests.", 429, { "Retry-After": String(retryAfter) });
    }
    const resource = form.get("resource");
    if (resource !== null && !sameResource(resource, this.context.resource)) {
      throw new OAuthError("invalid_target", "The resource is not this server's.");
    }

    switch (form.get("grant_type")) {
      case "authorization_code": {
        const code = form.get("code") ?? "";
        const record = code.startsWith(CODE_PREFIX) ? await this.store.findCode(hash(code)) : null;
        if (!record || record.clientId !== client.clientId) {
          throw new OAuthError("invalid_grant", "The authorization code is not valid.");
        }
        if (!(await this.store.use(record.hash, record.expiresAt + CODE_TTL))) {
          // A code redeemed twice was intercepted, or is being replayed:
          // whatever the first redemption got is revoked with it.
          await this.store.revokeFamily(record.familyId);
          throw new OAuthError("invalid_grant", "The authorization code was already used.");
        }
        if (record.expiresAt <= Date.now()) throw new OAuthError("invalid_grant", "The authorization code expired.");
        if (form.get("redirect_uri") !== null && form.get("redirect_uri") !== record.redirectUri) {
          throw new OAuthError("invalid_grant", "redirect_uri is not the one the code was issued to.");
        }
        const verifier = form.get("code_verifier");
        if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(s256(verifier), record.codeChallenge)) {
          throw new OAuthError("invalid_grant", "The PKCE code_verifier does not match.");
        }
        if (!(await this.options.findUser(record.userId))) {
          throw new OAuthError("invalid_grant", "The authorization code is not valid.");
        }
        return await this.issue(record);
      }
      case "refresh_token": {
        const token = form.get("refresh_token") ?? "";
        const record = token.startsWith(REFRESH_PREFIX) ? await this.store.findToken(hash(token)) : null;
        if (!record || record.kind !== "refresh" || record.clientId !== client.clientId) {
          throw new OAuthError("invalid_grant", "The refresh token is not valid.");
        }
        if (record.expiresAt <= Date.now()) throw new OAuthError("invalid_grant", "The refresh token expired.");
        if (!(await this.store.use(record.hash, record.expiresAt))) {
          // Rotation means a refresh token works once. A second use is a
          // stolen copy, or the thief's — either way the grant is done.
          await this.store.revokeFamily(record.familyId);
          throw new OAuthError("invalid_grant", "The refresh token was already used.");
        }
        if (record.resource !== this.context.resource) {
          throw new OAuthError("invalid_grant", "The refresh token was not issued for this server.");
        }
        let scopes = record.scopes;
        const asked = form.get("scope");
        if (asked !== null && asked.trim() !== "") {
          const narrowed = [...new Set(asked.split(" ").filter(Boolean))];
          if (narrowed.some((scope) => !record.scopes.includes(scope))) {
            throw new OAuthError("invalid_scope", "A refresh can only narrow the scopes that were granted.");
          }
          scopes = narrowed;
        }
        if (!(await this.options.findUser(record.userId))) {
          throw new OAuthError("invalid_grant", "The refresh token is not valid.");
        }
        return await this.issue({ ...record, scopes });
      }
      default:
        throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
    }
  }

  private async issue(grant: { clientId: string; userId: string; scopes: string[]; resource: string; familyId: string }) {
    const now = Date.now();
    // Scopes the router no longer has are dropped as the grant renews.
    const known = this.scopeNames();
    const scopes = grant.scopes.filter((scope) => known.includes(scope));
    const access = `${ACCESS_PREFIX}${randomBytes(32).toString("base64url")}`;
    const refresh = `${REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
    const base = { clientId: grant.clientId, userId: grant.userId, scopes, resource: grant.resource, familyId: grant.familyId };
    await this.store.saveToken({ ...base, hash: hash(access), kind: "access", expiresAt: now + this.accessTtl * 1000 } satisfies McpOAuthToken);
    await this.store.saveToken({ ...base, hash: hash(refresh), kind: "refresh", expiresAt: now + this.refreshTtl * 1000 } satisfies McpOAuthToken);
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: this.accessTtl,
      refresh_token: refresh,
      scope: scopes.join(" "),
    });
  }

  /** RFC 7009: revokes the grant the token belongs to. Answers 200 whatever the token was. */
  private async revoke(req: Request): Promise<Response> {
    const form = await readForm(req);
    const client = await this.authenticateClient(req, form);
    const token = form.get("token") ?? "";
    if (token.startsWith(ACCESS_PREFIX) || token.startsWith(REFRESH_PREFIX)) {
      const record = await this.store.findToken(hash(token));
      if (record && record.clientId === client.clientId) await this.store.revokeFamily(record.familyId);
    }
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  /**
   * The client a token or revocation request is from. A public client names
   * itself; a confidential one proves it with its secret, in the body or in
   * Basic auth.
   */
  private async authenticateClient(req: Request, form: URLSearchParams): Promise<McpOAuthClient> {
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get("authorization") ?? "");
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) throw invalidClient(true);
      const id = decodeURIComponent(decoded.slice(0, colon));
      if (clientId !== null && clientId !== id) throw invalidClient(true);
      clientId = id;
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = clientId ? await this.store.findClient(clientId) : null;
    if (!client) throw invalidClient(Boolean(basic));
    if (client.tokenEndpointAuthMethod === "none") {
      if (secret) throw invalidClient(Boolean(basic));
      return client;
    }
    if (!secret || !client.clientSecretHash || !equal(hash(secret), client.clientSecretHash)) {
      throw invalidClient(Boolean(basic));
    }
    return client;
  }

  // --- helpers -------------------------------------------------------------

  private redirectBack(uri: string, state: string | null, params: Record<string, string>, status = 302): Response {
    const url = new URL(uri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (state !== null) url.searchParams.set("state", state);
    url.searchParams.set("iss", this.issuer);
    return redirect(url.href, status);
  }

  /** The user signed in to this app in the browser: the session cookie only. */
  private async sessionUser(req: Request): Promise<User | null> {
    const cookies = new HttpRequest(req, {}, "api", this.base).cookies;
    return await sessionUser(app(AuthManager), {
      cookies,
      headers: { get: (name: string) => (name.toLowerCase() === "user-agent" ? req.headers.get("user-agent") : null) },
    });
  }

  private userLabel(user: User): string {
    if (this.options.userLabel) return this.options.userLabel(user);
    const record = user as unknown as Record<string, unknown>;
    return String(record.email ?? record.name ?? record.id);
  }

  private scopeNames(): string[] {
    return this.context.registry.scopes().map((scope) => scope.name);
  }

  private resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource${new URL(this.context.resource).pathname}`;
  }
}

const CORS_ANY: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

function seconds(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 60) throw new Error(`McpOAuthServer: ${name} must be a whole number of seconds, at least 60.`);
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...headers },
  });
}

function redirect(location: string, status: number): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

function htmlError(message: string, status = 400): Response {
  return new Response(errorPage(message), { status, headers: CONSENT_PAGE_HEADERS });
}

function invalidClient(basic: boolean): OAuthError {
  return new OAuthError(
    "invalid_client",
    "Client authentication failed.",
    401,
    basic ? { "WWW-Authenticate": 'Basic realm="mcp-oauth"' } : {},
  );
}

async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("too large");
  const text = await req.text();
  if (Buffer.byteLength(text) > max) throw new Error("too large");
  return text;
}

async function readForm(req: Request): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
    throw new OAuthError("invalid_request", "Send the request as application/x-www-form-urlencoded.");
  }
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readLimited(req, MAX_FORM_BYTES));
  } catch {
    throw new OAuthError("invalid_request", "The request is too large.");
  }
  for (const key of new Set(form.keys())) {
    if (form.getAll(key).length > 1) throw new OAuthError("invalid_request", `${key} was sent more than once.`);
  }
  return form;
}

function optionalText(value: unknown, max: number, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max || hasControlCharacter(value)) {
    throw new OAuthError("invalid_client_metadata", `${name} must be text of at most ${max} characters.`);
  }
  return value;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Why a redirect URI cannot be registered, or `null`. */
function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return "not a URI";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not an absolute URI";
  }
  if (url.hash || value.includes("#")) return "must not have a fragment";
  if (url.username || url.password) return "must not carry credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopback(url)) return null;
  return "must be https, or http on a loopback address";
}

/**
 * Exact match, as OAuth 2.1 requires — except the port of a loopback
 * redirect, which a native client picks when it runs (RFC 8252 §7.3).
 */
function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(given);
  } catch {
    return false;
  }
  return (
    a.protocol === "http:" &&
    b.protocol === "http:" &&
    isLoopback(a) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    !b.hash &&
    !b.username &&
    !b.password
  );
}

function sameResource(given: string, resource: string): boolean {
  return given === resource || given === `${resource}/`;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
