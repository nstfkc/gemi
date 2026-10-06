import { createHash, randomBytes } from "node:crypto";

import { canonicalize, purposeKey } from "../../../ai/signing";
import { MemoryNonceStore, type NonceStore } from "../../../ai/store/Nonces";
import { app } from "../../../foundation/app";
import { HttpRequest } from "../../../http/HttpRequest";
import type { ProgressUpdate } from "../../../http/modelOriginated";
import { RequestContext } from "../../../http/requestContext";
import { RateLimiter } from "../../rate-limiter/RateLimiter";
import {
  McpCallRefusedError,
  McpToolError,
  type McpCaller,
  type McpRegistry,
  type McpRemotePrincipal,
  type McpToolDescriptor,
} from "../McpRegistry";
import type { McpCallerResolver, McpResolveContext } from "./callers";
import {
  classify,
  decodeHeaderValue,
  ErrorCode,
  errorResponse,
  isObject,
  JsonRpcError,
  LEGACY_VERSIONS,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  MODERN_VERSIONS,
  SUPPORTED_VERSIONS,
  toolJson,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LegacyVersion,
} from "./protocol";
import { sign, verify } from "./signedState";

/**
 * `route.mcp.remote`: the MCP endpoint remote clients connect to (#762).
 */
export type McpRemoteHttpConfig = {
  /**
   * Off unless `true`. The endpoint is not mounted, and nothing below is
   * read, until an app turns it on.
   */
  enabled?: boolean;
  /**
   * The endpoint's canonical URL, like `"https://example.com/mcp"`: where it
   * is served (its path), which host it answers on, and the OAuth `resource`
   * tokens must be issued for. `https`, or `http` on localhost. Required when
   * `enabled`.
   */
  url?: string;
  /**
   * Who may call: tried in order, and at least one is required — the boot is
   * refused without one, since an endpoint that resolves nobody would be
   * either useless or, worse, open. See `McpCallerResolver`,
   * and `McpApiKeyResolver`.
   */
  resolvers?: McpCallerResolver[];
  /**
   * Browser origins allowed to call the endpoint, besides its own. A request
   * with any other `Origin` is refused with 403 — what keeps a page the user
   * visits, or a DNS-rebound host, from talking to it. Requests without an
   * `Origin` (every non-browser client) are not affected.
   */
  allowedOrigins?: readonly string[];
  /**
   * Each remote credential's budget at the endpoint, per `window` seconds:
   * every JSON-RPC request counts once. Default 600 per 60 s. `false` turns
   * it off. Tool calls also spend their routes' own `rate-limit` budgets,
   * keyed on the credential.
   */
  rateLimit?: { limit: number; window: number } | false;
  /** The largest request body accepted, in bytes. Default: room for one file of `files.maxBytes` as base64, plus 1 MiB. */
  maxBodyBytes?: number;
  /** What `initialize` and `server/discover` say about the server. */
  server?: { name?: string; version?: string; instructions?: string };
  /**
   * Where single-use approvals are spent. The default remembers them in
   * this process, which is right for one instance; with several, use a shared
   * store (`RedisNonceStore`), or an approval answered to one instance could
   * be replayed to another within its ten minutes.
   */
  nonces?: NonceStore;
  /** How long a legacy client waits to answer an approval prompt, in ms. Default 10 minutes. */
  approvalTimeoutMs?: number;
};

const REQUEST_STATE = "gemi.mcp.request-state.v1";
const SESSION = "gemi.mcp.session.v1";
const SESSION_TTL = 24 * 60 * 60 * 1000;
const APPROVAL_TTL = 10 * 60 * 1000;
const APPROVAL_KEY = "gemi_approval";
const DEFAULT_RATE_LIMIT = { limit: 600, window: 60 };

/** What a legacy session carries: no authority, only what was negotiated. */
type SessionState = {
  /** The negotiated legacy protocol version. */
  v: LegacyVersion;
  /** Whether the client can be asked to approve a call (form elicitation). */
  e: boolean;
  /** The credential the session was opened under, hashed. */
  p: string;
  exp: number;
};

type RequestState = {
  /** The credential, hashed. */
  p: string;
  /** The tool and a digest of its arguments: the call the approval is for. */
  t: string;
  a: string;
  /** Single-use. */
  n: string;
  exp: number;
};

/** A request, as the handlers see it once the transport has decided who and which era. */
type Call = {
  principal: McpRemotePrincipal;
  caller: McpCaller;
  message: JsonRpcRequest & { id: JsonRpcId };
  params: Record<string, unknown>;
  era: { modern: true } | { modern: false; session: SessionState; sessionId: string };
  stream: Stream | null;
  signal: AbortSignal;
};

/**
 * The MCP endpoint: Streamable HTTP, for remote MCP clients (#762).
 *
 * One URL, POST only. It serves both eras of the protocol (see
 * `./protocol.ts`): a modern client is served statelessly, and a legacy one
 * through a session opened by `initialize`. Every request is authenticated —
 * there is no unauthenticated method — by the configured resolvers, and
 * every tool call is handed to `McpRegistry.execute` as a remote caller, so
 * the route's middleware is the only authorization, exactly as for the
 * user's own request.
 *
 * Mounted by `App.fetch` ahead of routing when `route.mcp.remote.enabled`.
 */
export class McpHttpServer {
  static token = "router.mcp.http";

  readonly endpoint: URL;
  private readonly resolvers: McpCallerResolver[];
  private readonly context: McpResolveContext;
  private readonly allowedOrigins: Set<string>;
  private readonly rateLimit: { limit: number; window: number } | false;
  private readonly maxBodyBytes: number;
  private readonly serverInfo: { name: string; version: string };
  private readonly instructions?: string;
  private readonly nonces: NonceStore;
  private readonly approvalTimeoutMs: number;
  /** Legacy elicitations waiting for the client's answer, by the request id they were sent under. */
  private readonly pending = new Map<
    string,
    { session: string; resolve: (message: JsonRpcResponse) => void }
  >();
  /** Legacy calls in flight, so `notifications/cancelled` can stop one. */
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly registry: McpRegistry,
    config: McpRemoteHttpConfig,
  ) {
    if (typeof config.url !== "string") {
      throw new Error(
        'route.mcp.remote.url is required: the endpoint\'s canonical URL, like "https://example.com/mcp".',
      );
    }
    this.endpoint = canonicalEndpoint(config.url);
    const resolvers = config.resolvers ?? [];
    if (!Array.isArray(resolvers) || resolvers.length === 0) {
      throw new Error(
        "route.mcp.remote is enabled without a caller resolver. Configure route.mcp.remote.resolvers — an McpOAuthServer, an McpApiKeyResolver, or your own — or leave the endpoint off. Without one every request would be refused, or answered as nobody.",
      );
    }
    for (const resolver of resolvers) {
      if (typeof resolver?.resolve !== "function" || typeof resolver.name !== "string" || resolver.name === "") {
        throw new Error("route.mcp.remote.resolvers: each resolver needs a name and a resolve().");
      }
    }
    this.resolvers = resolvers;
    // Fails the boot rather than the first tool call when SECRET is missing:
    // sessions and approvals are signed with it.
    purposeKey(REQUEST_STATE);
    this.context = { resource: this.resource, registry };
    this.allowedOrigins = new Set(
      (config.allowedOrigins ?? []).map((origin) => {
        const url = new URL(origin);
        if (url.origin !== origin) {
          throw new Error(`route.mcp.remote.allowedOrigins: "${origin}" is not an origin (scheme://host[:port]).`);
        }
        return origin;
      }),
    );
    this.allowedOrigins.add(this.endpoint.origin);
    this.rateLimit = config.rateLimit === false ? false : (config.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.maxBodyBytes =
      config.maxBodyBytes ?? Math.ceil(registry.maxFileBytes * 1.4) + 1024 * 1024;
    this.serverInfo = {
      name: config.server?.name ?? "gemi",
      version: config.server?.version ?? "1.0.0",
    };
    this.instructions = config.server?.instructions;
    this.nonces = config.nonces ?? new MemoryNonceStore();
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? APPROVAL_TTL;
    for (const resolver of resolvers) resolver.boot?.(this.context);
  }

  /** The endpoint's URL as a resource identifier: no trailing slash, no query. */
  get resource(): string {
    return this.endpoint.href.replace(/\/$/, "");
  }

  /**
   * Answers a request that is the endpoint's, or one of its resolvers' (OAuth
   * metadata and endpoints), and `null` for anything else.
   *
   * Only on the configured host. The name a client used is compared, not
   * trusted: a DNS-rebinding page reaches this server under its own host name,
   * and is answered by the app's ordinary routes, never by this.
   */
  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.host !== this.endpoint.host) return null;
    for (const resolver of this.resolvers) {
      const answered = await resolver.handle?.(req, this.context);
      if (answered) return answered;
    }
    if (url.pathname !== this.endpoint.pathname) return null;

    const origin = req.headers.get("origin");
    if (origin !== null && !this.allowedOrigins.has(origin)) {
      return jsonResponse(
        errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, "Origin not allowed.")),
        403,
      );
    }
    const cors = origin ? corsHeaders(origin) : {};

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (req.method !== "POST") {
      // No standalone stream (GET) and no session to end (DELETE): sessions
      // are signed, not stored, so there is nothing to delete.
      return withHeaders(new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } }), cors);
    }
    return withHeaders(await this.post(req), cors);
  }

  // --- the request ---------------------------------------------------------

  private async post(req: Request): Promise<Response> {
    // Authenticated before the body is read: nobody gets a large body parsed
    // without a credential.
    let principal: McpRemotePrincipal | null = null;
    for (const resolver of this.resolvers) {
      const resolution = await resolver.resolve(req, this.context);
      if (resolution === null) continue;
      if (resolution.ok === false) {
        return this.unauthorized(resolution.description);
      }
      principal = { ...resolution.principal, via: resolver.name };
      break;
    }
    if (!principal) return this.unauthorized();

    const limited = await this.spend(principal);
    if (limited) return limited;

    const type = req.headers.get("content-type") ?? "";
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      return new Response("Content-Type must be application/json.", { status: 415 });
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, this.maxBodyBytes));
    } catch (error) {
      if (error instanceof TooLarge) {
        return jsonResponse(
          errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, `The request is larger than ${this.maxBodyBytes} bytes.`)),
          413,
        );
      }
      return jsonResponse(errorResponse(null, new JsonRpcError(ErrorCode.ParseError, "Parse error.")), 400);
    }

    const httpRequest = new HttpRequest(req, {}, "api", this.endpoint.pathname);
    return await RequestContext.run(
      httpRequest,
      async () => {
        try {
          return await this.dispatch(req, httpRequest, principal!, body);
        } catch (error) {
          if (error instanceof JsonRpcError) {
            const id = isObject(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
            return jsonResponse(errorResponse(id, error), error.status);
          }
          console.error("[gemi/mcp] The MCP endpoint failed:", error);
          return jsonResponse(errorResponse(null, new JsonRpcError(ErrorCode.InternalError, "Internal error.")), 500);
        }
      },
      // The principal's user is this request's signed-in user, so a binder
      // reading `req.ctx().user` reads the same user a local run's would.
      { user: principal.user },
    );
  }

  private async dispatch(
    req: Request,
    httpRequest: HttpRequest,
    principal: McpRemotePrincipal,
    body: unknown,
  ): Promise<Response> {
    const incoming = classify(body);
    const caller: McpCaller = { kind: "remote", req: httpRequest, principal };

    // A client's answer to an approval this server asked a legacy client for.
    if (incoming.kind === "response") {
      const session = this.session(req, principal);
      const waiting = this.pending.get(String(incoming.message.id));
      if (waiting && waiting.session === session.id) {
        this.pending.delete(String(incoming.message.id));
        waiting.resolve(incoming.message);
      }
      return new Response(null, { status: 202 });
    }

    const { message } = incoming;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const meta = isObject(params._meta) ? params._meta : {};

    if (typeof meta[META_PROTOCOL_VERSION] === "string") {
      this.checkModernHeaders(req, message, meta[META_PROTOCOL_VERSION] as string);
      if (incoming.kind === "notification") return new Response(null, { status: 202 });
      return await this.respond(message as Call["message"], async (stream, signal) =>
        this.modern({
          principal,
          caller,
          message: message as Call["message"],
          params,
          era: { modern: true },
          stream,
          signal,
        }),
      wantsStream(params), req.signal);
    }

    if (message.method === "initialize") {
      if (incoming.kind !== "request") {
        throw new JsonRpcError(ErrorCode.InvalidRequest, "initialize is a request.", undefined, 400);
      }
      return this.initialize(incoming.message, params, principal);
    }

    // A legacy request: it belongs to a session `initialize` opened.
    const session = this.session(req, principal);
    const versionHeader = req.headers.get("mcp-protocol-version");
    if (versionHeader !== null && versionHeader !== session.state.v) {
      throw new JsonRpcError(
        ErrorCode.InvalidRequest,
        `MCP-Protocol-Version ${versionHeader} is not the session's ${session.state.v}.`,
        undefined,
        400,
      );
    }
    if (incoming.kind === "notification") {
      if (message.method === "notifications/cancelled") {
        const requestId = params.requestId;
        this.inflight.get(`${session.id}:${String(requestId)}`)?.abort();
      }
      return new Response(null, { status: 202 });
    }
    const inflightKey = `${session.id}:${String(message.id)}`;
    const controller = new AbortController();
    this.inflight.set(inflightKey, controller);
    const signal = AbortSignal.any([controller.signal, req.signal]);
    try {
      return await this.respond(
        message as Call["message"],
        async (stream, signal) =>
          this.legacy({
            principal,
            caller,
            message: message as Call["message"],
            params,
            era: { modern: false, session: session.state, sessionId: session.id },
            stream,
            signal,
          }),
        wantsStream(params) || needsApproval(this.registry, message, session.state),
        signal,
        () => this.inflight.delete(inflightKey),
      );
    } catch (error) {
      this.inflight.delete(inflightKey);
      throw error;
    }
  }

  // --- the two eras -----------------------------------------------------------

  private async modern(call: Call): Promise<unknown> {
    switch (call.message.method) {
      case "server/discover":
        return this.complete({
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          ...(this.instructions ? { instructions: this.instructions } : {}),
          ttlMs: 60_000,
          cacheScope: "private",
        });
      case "tools/list":
        return this.complete({
          tools: this.registry.list(call.caller).map((tool) => toolJson(tool, true)),
          // The list is the credential's: its scopes decide it.
          ttlMs: 60_000,
          cacheScope: "private",
        });
      case "tools/call":
        return await this.callTool(call);
      default:
        throw new JsonRpcError(ErrorCode.MethodNotFound, `Method not found: ${call.message.method}`, undefined, 404);
    }
  }

  private async legacy(call: Call): Promise<unknown> {
    switch (call.message.method) {
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.registry.list(call.caller).map((tool) => toolJson(tool, false)) };
      case "tools/call":
        return await this.callTool(call);
      default:
        throw new JsonRpcError(ErrorCode.MethodNotFound, `Method not found: ${call.message.method}`);
    }
  }

  private complete(result: Record<string, unknown>) {
    return {
      resultType: "complete",
      ...result,
      _meta: { [META_SERVER_INFO]: this.serverInfo },
    };
  }

  private initialize(message: JsonRpcRequest & { id: JsonRpcId }, params: Record<string, unknown>, principal: McpRemotePrincipal) {
    const requested = params.protocolVersion;
    const version = (LEGACY_VERSIONS as readonly string[]).includes(requested as string)
      ? (requested as LegacyVersion)
      : LEGACY_VERSIONS[0];
    const capabilities = isObject(params.capabilities) ? params.capabilities : {};
    const state: SessionState = {
      v: version,
      e: supportsFormElicitation(capabilities.elicitation),
      p: principalKey(principal),
      exp: Date.now() + SESSION_TTL,
    };
    const sessionId = sign(SESSION, "gms1", state);
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.serverInfo,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        },
      },
      200,
      { "Mcp-Session-Id": sessionId },
    );
  }

  /**
   * The legacy session a request names, verified and bound to the credential
   * it was opened under. A session id is not a credential — every request is
   * authenticated on its own — but one opened under somebody else's token is
   * refused all the same (404, which tells the client to start over), so a
   * session id handed to a victim cannot carry the attacker's negotiation
   * into the victim's calls.
   */
  private session(req: Request, principal: McpRemotePrincipal): { id: string; state: SessionState } {
    const id = req.headers.get("mcp-session-id");
    if (!id) {
      throw new JsonRpcError(
        ErrorCode.InvalidRequest,
        "Missing Mcp-Session-Id. Send initialize first, or a request carrying io.modelcontextprotocol/protocolVersion in _meta.",
        undefined,
        400,
      );
    }
    const state = verify<SessionState>(SESSION, "gms1", id);
    if (!state || state.p !== principalKey(principal)) {
      throw new JsonRpcError(ErrorCode.InvalidRequest, "Session not found.", undefined, 404);
    }
    return { id, state };
  }

  private checkModernHeaders(req: Request, message: JsonRpcRequest, version: string) {
    if (!(MODERN_VERSIONS as readonly string[]).includes(version)) {
      throw new JsonRpcError(
        ErrorCode.UnsupportedProtocolVersion,
        "Unsupported protocol version",
        { supported: SUPPORTED_VERSIONS, requested: version },
        400,
      );
    }
    const mismatch = (what: string) =>
      new JsonRpcError(ErrorCode.HeaderMismatch, `Header mismatch: ${what}`, undefined, 400);
    if (req.headers.get("mcp-protocol-version") !== version) {
      throw mismatch("MCP-Protocol-Version does not match the protocol version in _meta.");
    }
    if (req.headers.get("mcp-method") !== message.method) {
      throw mismatch("Mcp-Method does not match the method.");
    }
    const params = message.params ?? {};
    const named =
      message.method === "tools/call" || message.method === "prompts/get"
        ? params.name
        : message.method === "resources/read"
          ? params.uri
          : undefined;
    if (named !== undefined) {
      const header = req.headers.get("mcp-name");
      if (header === null || decodeHeaderValue(header) !== named) {
        throw mismatch("Mcp-Name does not match the request's name.");
      }
    }
  }

  // --- tools/call ------------------------------------------------------------

  private async callTool(call: Call): Promise<unknown> {
    const { params, caller, principal } = call;
    const name = params.name;
    if (typeof name !== "string") {
      throw new JsonRpcError(ErrorCode.InvalidParams, "tools/call needs a tool name.");
    }
    const args = params.arguments ?? {};
    const tool = this.registry.list(caller, { names: [name] })[0];
    if (!tool) {
      // A tool this credential cannot see is answered as one that does not
      // exist, as the registry would.
      throw new JsonRpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    let approved = false;
    if (tool.requiresApproval) {
      // Checked before the user is asked: approving a call that cannot run
      // wastes their attention, and the model can fix its arguments first.
      const parsed = tool.inputSchema.safeParse(args);
      if (parsed.ok === false) {
        return this.toolResult(call, {
          content: [{ type: "text", text: `Invalid arguments for "${name}": ${parsed.errors.join(", ")}` }],
          isError: true,
        });
      }
      const decision = await this.approval(call, tool, args);
      if (decision.kind === "answer") return decision.result;
      approved = true;
    }

    const progress = progressSink(call);
    let value: unknown;
    try {
      value = await this.registry.execute(caller, name, args, undefined, {
        approved,
        signal: call.signal,
        ...(progress ? { progress } : {}),
      });
    } catch (error) {
      if (error instanceof McpToolError) {
        return this.toolResult(call, { content: [{ type: "text", text: error.message }], isError: true });
      }
      if (error instanceof McpCallRefusedError) {
        throw new JsonRpcError(ErrorCode.InvalidParams, error.reason === "unknown-tool" ? `Unknown tool: ${name}` : error.message);
      }
      console.error(`[gemi/mcp] "${name}" failed for ${principal.via}:${principal.id}:`, error);
      return this.toolResult(call, {
        content: [{ type: "text", text: `"${name}" failed on the server.` }],
        isError: true,
      });
    }

    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const structured =
      tool.outputSchema && (call.era.modern || isObject(value)) ? { structuredContent: value } : {};
    return this.toolResult(call, { content: [{ type: "text", text }], ...structured, isError: false });
  }

  private toolResult(call: Call, result: Record<string, unknown>) {
    return call.era.modern ? this.complete(result) : result;
  }

  /**
   * Asks the user whether a `requiresApproval` tool may run, and answers
   * either that it may (`approved`) or the result to send instead.
   *
   * Modern clients are asked statelessly: the call is answered
   * `input_required` with an elicitation and a signed `requestState` bound to
   * the credential, the tool, a digest of the arguments and ten minutes; the
   * retry carries the user's answer and the state back, and the state is
   * spent so the same approval cannot run the call twice. Legacy clients are
   * asked on the call's own stream and the call waits for the answer.
   *
   * A client that cannot ask is refused: the call does not run unapproved.
   */
  private async approval(
    call: Call,
    tool: McpToolDescriptor,
    args: unknown,
  ): Promise<{ kind: "approved" } | { kind: "answer"; result: unknown }> {
    const request = approvalRequest(tool, args);
    const declined = (why: string) => ({
      kind: "answer" as const,
      result: this.toolResult(call, { content: [{ type: "text", text: why }], isError: true }),
    });

    if (call.era.modern) {
      const meta = isObject(call.params._meta) ? call.params._meta : {};
      const capabilities = isObject(meta[META_CLIENT_CAPABILITIES]) ? meta[META_CLIENT_CAPABILITIES] : {};
      const responses = isObject(call.params.inputResponses) ? call.params.inputResponses : null;
      const stateValue = call.params.requestState;
      const digest = argumentsDigest(args);
      if (responses && stateValue !== undefined) {
        const state = verify<RequestState>(REQUEST_STATE, "grs1", stateValue);
        if (!state || state.p !== principalKey(call.principal) || state.t !== tool.name || state.a !== digest) {
          throw new JsonRpcError(ErrorCode.InvalidParams, "requestState is not valid for this call.");
        }
        if (!(await this.spendNonce(state.n, state.exp))) {
          throw new JsonRpcError(ErrorCode.InvalidParams, "requestState has already been used.");
        }
        return accepted(responses[APPROVAL_KEY])
          ? { kind: "approved" }
          : declined(`The user did not approve "${tool.name}", and it did not run.`);
      }
      if (!supportsFormElicitation(capabilities.elicitation)) {
        throw new JsonRpcError(
          ErrorCode.MissingRequiredClientCapability,
          `"${tool.name}" needs the user's approval, and this client cannot ask for it (elicitation).`,
          { requiredCapabilities: { elicitation: { form: {} } } },
          400,
        );
      }
      const state: RequestState = {
        p: principalKey(call.principal),
        t: tool.name,
        a: digest,
        n: randomBytes(16).toString("base64url"),
        exp: Date.now() + APPROVAL_TTL,
      };
      return {
        kind: "answer",
        result: {
          resultType: "input_required",
          inputRequests: { [APPROVAL_KEY]: { method: "elicitation/create", params: { mode: "form", ...request } } },
          requestState: sign(REQUEST_STATE, "grs1", state),
          _meta: { [META_SERVER_INFO]: this.serverInfo },
        },
      };
    }

    const era = call.era as Extract<Call["era"], { modern: false }>;
    if (!era.session.e || !call.stream) {
      return declined(
        `"${tool.name}" needs the user's approval, and this client cannot ask for it (elicitation). It did not run.`,
      );
    }
    const id = `gemi-approval-${randomBytes(12).toString("base64url")}`;
    const sessionId = era.sessionId;
    const answer = await new Promise<JsonRpcResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.approvalTimeoutMs);
      const done = (message: JsonRpcResponse | null) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.pending.set(id, { session: sessionId, resolve: done });
      call.signal.addEventListener("abort", () => {
        this.pending.delete(id);
        done(null);
      });
      call.stream!.send({
        jsonrpc: "2.0",
        id,
        method: "elicitation/create",
        params: era.session.v === "2025-11-25" ? { mode: "form", ...request } : request,
      });
    });
    return answer && !answer.error && accepted(answer.result)
      ? { kind: "approved" }
      : declined(`The user did not approve "${tool.name}", and it did not run.`);
  }

  private async spendNonce(nonce: string, expiresAt: number): Promise<boolean> {
    try {
      return await this.nonces.consume(nonce, expiresAt);
    } catch (error) {
      // A replay guard that lets an answer through when its store is down is
      // not a guard.
      console.error("[gemi/mcp] Spending an approval failed:", error);
      return false;
    }
  }

  // --- responding --------------------------------------------------------------

  /**
   * Runs `handler` and answers its result: as one JSON response, or — when
   * the client asked for progress, or a legacy approval has to be asked on
   * the way — as an SSE stream that ends with it. Closing the stream cancels
   * the call.
   */
  private async respond(
    message: JsonRpcRequest & { id: JsonRpcId },
    handler: (stream: Stream | null, signal: AbortSignal) => Promise<unknown>,
    streaming: boolean,
    signal: AbortSignal,
    finished?: () => void,
  ): Promise<Response> {
    if (!streaming) {
      try {
        const result = await handler(null, signal);
        return jsonResponse({ jsonrpc: "2.0", id: message.id, result }, 200);
      } finally {
        finished?.();
      }
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    const stream = new Stream(() => controller.abort());
    void (async () => {
      try {
        const result = await handler(stream, combined);
        stream.send({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        if (error instanceof JsonRpcError) {
          stream.send(errorResponse(message.id, error));
        } else {
          console.error("[gemi/mcp] The MCP endpoint failed:", error);
          stream.send(errorResponse(message.id, new JsonRpcError(ErrorCode.InternalError, "Internal error.")));
        }
      } finally {
        finished?.();
        stream.close();
      }
    })();
    return new Response(stream.readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private unauthorized(description?: string): Response {
    const challenge =
      this.resolvers.map((resolver) => resolver.challenge?.(this.context)).find(Boolean) ?? 'Bearer realm="mcp"';
    const value = description
      ? `${challenge}, error="invalid_token", error_description="${description.replace(/["\\]/g, "")}"`
      : challenge;
    return jsonResponse(
      errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, "Unauthorized.")),
      401,
      { "WWW-Authenticate": value },
    );
  }

  private async spend(principal: McpRemotePrincipal): Promise<Response | null> {
    if (!this.rateLimit) return null;
    const limiter = resolveLimiter();
    if (!limiter) return null;
    const result = await limiter.consume(`mcp-endpoint:${principal.via}:${principal.id}`, this.rateLimit);
    if (result.allowed) return null;
    return jsonResponse(
      errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, "Rate limit exceeded.")),
      429,
      { "Retry-After": String(Math.max(1, Math.ceil(result.retryAfter / 1000))) },
    );
  }
}

/** An SSE response body, one JSON-RPC message per event. */
class Stream {
  readonly readable: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(onCancel: () => void) {
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
        onCancel();
      },
    });
  }

  send(message: unknown) {
    if (this.closed) return;
    this.controller.enqueue(this.encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

class TooLarge extends Error {}

async function readBody(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
    Vary: "Origin",
  };
}

function canonicalEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`route.mcp.remote.url: "${value}" is not a URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("route.mcp.remote.url must be https (http only on localhost): tokens travel to it.");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("route.mcp.remote.url must have no query, fragment or credentials.");
  }
  if (url.pathname === "/" || url.pathname.endsWith("/")) {
    throw new Error('route.mcp.remote.url needs a path of its own, like "/mcp", without a trailing slash.');
  }
  return url;
}

function principalKey(principal: McpRemotePrincipal): string {
  return createHash("sha256").update(`${principal.via}\0${principal.id}\0${principal.user?.id}`).digest("base64url").slice(0, 32);
}

function argumentsDigest(args: unknown): string {
  return createHash("sha256").update(canonicalize(args ?? {})).digest("base64url");
}

/** Form-mode elicitation: `{}` (form only, for compatibility) or `{ form: … }`. */
function supportsFormElicitation(elicitation: unknown): boolean {
  if (!isObject(elicitation)) return false;
  if (Object.keys(elicitation).length === 0) return true;
  return "form" in elicitation;
}

function wantsStream(params: Record<string, unknown>): boolean {
  const meta = isObject(params._meta) ? params._meta : {};
  return typeof meta.progressToken === "string" || typeof meta.progressToken === "number";
}

/** Whether a legacy tools/call will ask for approval on its stream. */
function needsApproval(registry: McpRegistry, message: JsonRpcRequest, session: SessionState): boolean {
  if (message.method !== "tools/call" || !session.e) return false;
  const name = message.params?.name;
  return typeof name === "string" && registry.descriptors({ names: [name] })[0]?.requiresApproval === true;
}

function progressSink(call: Call): ((update: ProgressUpdate) => void) | undefined {
  const meta = isObject(call.params._meta) ? call.params._meta : {};
  const token = meta.progressToken;
  if (!call.stream || (typeof token !== "string" && typeof token !== "number")) return undefined;
  let last = -Infinity;
  return (update) => {
    if (typeof update?.progress !== "number" || !Number.isFinite(update.progress) || update.progress <= last) return;
    last = update.progress;
    call.stream!.send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: update.progress,
        ...(typeof update.total === "number" ? { total: update.total } : {}),
        ...(typeof update.message === "string" ? { message: update.message.slice(0, 1000) } : {}),
      },
    });
  };
}

/** The form a user answers to let a tool run. */
function approvalRequest(tool: McpToolDescriptor, args: unknown) {
  const shown = JSON.stringify(args ?? {});
  const summary = shown.length > 600 ? `${shown.slice(0, 600)}…` : shown;
  return {
    message: `Allow "${tool.title ?? tool.name}" to run? ${tool.description}\n\nArguments: ${summary}`,
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve",
          description: `Run "${tool.title ?? tool.name}" with these arguments.`,
        },
      },
      required: ["approve"],
    },
  };
}

/** An elicitation result the user accepted with `approve: true`. Anything else is a no. */
function accepted(result: unknown): boolean {
  return isObject(result) && result.action === "accept" && isObject(result.content) && result.content.approve === true;
}

function resolveLimiter(): RateLimiter | null {
  try {
    const container = app();
    return container.bound(RateLimiter) ? container.make(RateLimiter) : null;
  } catch {
    return null;
  }
}
