import type { AnySchema, Infer } from "../ai/Schema";
import type { ServiceToken } from "../container/Container";
import { app } from "../foundation/app";
import type { MiddlewareRegistry } from "../services/middleware/MiddlewareRegistry";
import type { McpToolAnnotations } from "../services/mcp/McpRegistry";
import { overBudget } from "../services/mcp/http/limits";
import {
  checkModernHeaders,
  classify,
  ErrorCode,
  errorResponse,
  isObject,
  JsonRpcError,
  LEGACY_VERSIONS,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SUPPORTED_VERSIONS,
} from "../services/mcp/http/protocol";
import type { DomainRouter } from "../services/router/DomainRouter";
import { RouteHandler, type HttpMethod } from "./ApiRouter";
import { HttpRequest } from "./HttpRequest";
import type { Middleware } from "./Middleware";
import { toMiddlewareList, type MiddlewareInput } from "./middlewareList";
import { clientAddress } from "./RateLimitMiddleware";
import { RateLimitExceededError } from "./RateLimitExceededError";
import { RequestContext } from "./requestContext";
import type { CorsPolicy } from "./corsPolicy";

// The services are looked up by their container token, not imported: they
// import the router, which imports this file through `this.mcp()`.
const DOMAIN_ROUTER = { token: "router.domains" } as unknown as ServiceToken<DomainRouter>;
const MIDDLEWARE = { token: "middleware" } as unknown as ServiceToken<MiddlewareRegistry>;

const DEFAULT_RATE_LIMIT = { limit: 600, window: 60 };
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const TWIN = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Who may call an `McpEndpoint`. Only `"anonymous"` for now: anyone, with no
 * credential and no user. Required, so that an endpoint open to everybody is
 * a decision written in the class rather than what a missing resolver means.
 */
export type McpEndpointCaller = "anonymous";

/** What a tool's `run` (and `offered`) is handed. */
export type McpEndpointCall<C> = {
  /** What the endpoint's `context(req)` answered for this request. */
  context: C;
  /**
   * The request the route got: its host's `req.domain.params`, its headers,
   * `clientIp(req)`. No user is resolved for it; the caller is anonymous.
   */
  req: HttpRequest<any, any>;
  /** The tool's name. */
  tool: string;
  /** The call's `params._meta`, as the client sent it (`{}` when there is none). */
  meta: Record<string, unknown>;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
};

/**
 * One tool of an `McpEndpoint`.
 *
 * `inputSchema` is either an `s` schema, which gemi lists as JSON Schema and
 * parses the arguments with (an invalid call is an `isError` result naming
 * what is wrong), or a JSON Schema object, listed exactly as written and not
 * checked: for a protocol that fixes its schemas (an OpenRPC document), with
 * `run` checking the arguments itself. Either way the arguments are an object.
 */
export type McpEndpointTool<C, A = any> = {
  title?: string;
  description: string;
  inputSchema: AnySchema | Record<string, unknown>;
  /** A JSON Schema of the result's `structuredContent`, listed as written. */
  outputSchema?: Record<string, unknown>;
  /** MCP's hints for a client. Advice, never a defence. */
  annotations?: McpToolAnnotations;
  /**
   * Whether this request offers the tool. Decides `tools/list` and
   * `tools/call` alike: a tool not offered is left out of the list, and a
   * call to it is answered as one to a tool that does not exist. Without it
   * the tool is always offered.
   */
  offered?: (context: C, req: HttpRequest<any, any>) => boolean | Promise<boolean>;
  /**
   * The budget a call spends, before its arguments are read:
   *
   * - `"POST /orders"`: the rate limits of that route, its twin. The route is
   *   looked up in the api of this request's host group (its full path,
   *   without `/api`), and the `rate-limit` middleware in its list — aliases
   *   configured with a `key` of your own included — run as they would for
   *   the route, with the route's `routePath` and this caller's address. Same
   *   middleware, same keys: the call and a direct request share one counter.
   * - `{ limit, window }`: a budget of the tool's own, per client address.
   *
   * Over budget, the call is answered JSON-RPC -32000, HTTP 429, with
   * `Retry-After`.
   */
  rateLimit?: `${HttpMethod} /${string}` | { limit: number; window: number };
  /**
   * Runs the call. What it answers becomes the result:
   *
   * - an object: `structuredContent`, and the same JSON as text;
   * - a string: the text;
   * - `McpEndpoint.result(body, { isError: true })`: a business outcome the
   *   client should read (a 404, a validation failure) as an error result,
   *   `structuredContent` included.
   *
   * Throw an `McpEndpointError` to answer a JSON-RPC error instead, with the
   * HTTP status and headers it names. Anything else thrown is logged and
   * answered as an error result that says only that the tool failed.
   */
  run: (args: A, call: McpEndpointCall<C>) => unknown | Promise<unknown>;
};

/**
 * A JSON-RPC error a tool answers instead of a result, with the HTTP status
 * the response goes out with (default 200) and any headers of its own.
 *
 * ```ts
 * throw new McpEndpointError(-32000, "Conflict", { status: 409, data: reply.body });
 * ```
 */
export class McpEndpointError extends Error {
  readonly status: number;
  readonly data?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    readonly code: number,
    message: string,
    options: { status?: number; data?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "McpEndpointError";
    this.status = options.status ?? 200;
    this.data = options.data;
    this.headers = options.headers;
  }
}

const RESULT = Symbol("McpEndpoint.result");

type ExplicitResult = {
  [RESULT]: true;
  body: unknown;
  isError: boolean;
  text?: string;
};

/**
 * An MCP endpoint served by a route, for callers who carry no credential: a
 * public protocol's MCP binding, on every host of a domain group (#1401).
 *
 * `route.mcp.remote` is the app's own endpoint: one URL, callers who signed
 * in (OAuth, an API key), the `McpRouter`'s tools run as them. This is the
 * other kind. It is mounted like any route, so it answers on whichever hosts
 * its router serves, and the request decides everything: its host's context,
 * which tools there are, and what each answers. Both can exist in one app.
 *
 * ```ts
 * export class ShopMcp extends McpEndpoint<Shop> {
 *   caller = "anonymous" as const;
 *   server = { name: "shop", version: "1.0.0" };
 *   context = (req: HttpRequest) => Shop.forHost(req.domain?.params.shop);
 *   tools = {
 *     search: this.tool({
 *       description: "Searches the catalog.",
 *       inputSchema: s.object({ query: s.string() }),
 *       offered: (shop) => shop.hasCatalog,
 *       rateLimit: "POST /catalog/search",
 *       run: ({ query }, { context }) => context.search(query),
 *     }),
 *   };
 * }
 *
 * // the shop group's api router
 * "/mcp": this.mcp(ShopMcp).middleware(["rate-limit:120"]),
 * ```
 *
 * The transport is Streamable HTTP, stateless: every POST is answered with
 * one JSON response. No session id is issued, no SSE stream is opened (a
 * progress token is ignored), and GET and DELETE answer 405. Both protocol
 * eras are spoken: `initialize`, `ping`, `tools/list`, `tools/call`, and the
 * 2026-07-28 stateless requests (`server/discover`, `_meta`).
 */
export abstract class McpEndpoint<C = undefined> {
  static readonly __brand = "McpEndpoint";

  /** Who may call. Required: see `McpEndpointCaller`. */
  abstract caller: McpEndpointCaller;

  /** What `initialize` and `server/discover` say about the server. */
  server?: { name?: string; version?: string; instructions?: string };

  /**
   * Each client address's budget at the endpoint, per `window` seconds: every
   * POST counts once. Default 600 per 60 s; `false` turns it off (the route's
   * own `rate-limit` middleware still runs). Tools spend their own budgets on
   * top (`rateLimit` on the tool).
   */
  rateLimit?: { limit: number; window: number } | false;

  /** The largest request body accepted, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;

  /** The tools, by name. */
  abstract tools: Record<string, McpEndpointTool<C>>;

  /**
   * Once per POST, before the body is read: what this request's tools work
   * on (the host's tenant, say). `null` answers 404, for a host that has
   * nothing to serve; a `Response` is answered as it is. Without it the
   * context is `undefined`.
   */
  context?(req: HttpRequest<any, any>): C | null | Response | Promise<C | null | Response>;

  /** Declares a tool, typed by the endpoint's context and the tool's schema. */
  protected tool<S extends AnySchema>(
    tool: McpEndpointTool<C, Infer<S>> & { inputSchema: S },
  ): McpEndpointTool<C>;
  protected tool(tool: McpEndpointTool<C, Record<string, unknown>>): McpEndpointTool<C>;
  protected tool(tool: McpEndpointTool<C, any>): McpEndpointTool<C> {
    return tool;
  }

  /**
   * A result said explicitly: `isError` for a business outcome the client
   * should read as a failure. `body` is the `structuredContent` (an object),
   * and its JSON the text unless `text` is given.
   */
  static result(body: unknown, options: { isError?: boolean; text?: string } = {}): ExplicitResult {
    return { [RESULT]: true, body, isError: options.isError === true, text: options.text };
  }

  // --- mounting ---------------------------------------------------------------

  /** @internal The routes `this.mcp(Endpoint)` mounts. */
  static __routes(this: new () => McpEndpoint<any>): McpEndpointRoute {
    const endpoint = new this();
    endpoint.check(this.name || "McpEndpoint");
    return new McpEndpointRoute(endpoint);
  }

  private checked?: string;

  private check(where: string) {
    this.checked = where;
    if ((this.caller as unknown) !== "anonymous") {
      throw new Error(
        `${where}: set \`caller = "anonymous" as const\` to serve this endpoint to anyone. It is required: an endpoint that names no caller would be open without anybody having said so.`,
      );
    }
    if (!isObject(this.tools)) {
      throw new Error(`${where}: tools must be an object of tools, by name.`);
    }
    for (const [name, tool] of Object.entries(this.tools)) {
      const at = `${where}: tool "${name}"`;
      if (!TOOL_NAME.test(name)) {
        throw new Error(`${at}: a tool name is 1 to 128 letters, digits, "_", "-" or ".".`);
      }
      if (!isObject(tool) || typeof tool.run !== "function" || typeof tool.description !== "string") {
        throw new Error(`${at} needs a description and a run().`);
      }
      if (!isObject(tool.inputSchema)) {
        throw new Error(`${at}: inputSchema must be an s schema or a JSON Schema object.`);
      }
      if (tool.offered !== undefined && typeof tool.offered !== "function") {
        throw new Error(`${at}: offered must be a function.`);
      }
      const limit = tool.rateLimit;
      if (typeof limit === "string") {
        if (!TWIN.test(limit)) {
          throw new Error(`${at}: rateLimit "${limit}" is not "METHOD /path", like "POST /orders".`);
        }
      } else if (limit !== undefined && !isBudget(limit)) {
        throw new Error(`${at}: rateLimit must be "METHOD /path" or { limit, window } in positive numbers.`);
      }
    }
    if (this.rateLimit !== undefined && this.rateLimit !== false && !isBudget(this.rateLimit)) {
      throw new Error(`${where}: rateLimit must be { limit, window } in positive numbers, or false.`);
    }
  }

  // --- the request --------------------------------------------------------------

  /** @internal */
  async __post(req: HttpRequest<any, any>): Promise<Response> {
    const raw = req.rawRequest;
    const budget = this.rateLimit === false ? null : (this.rateLimit ?? DEFAULT_RATE_LIMIT);
    if (budget) {
      const retryAfter = await overBudget(`mcp-endpoint:${clientAddress(req)}:${req.routePath ?? "*"}`, budget);
      if (retryAfter !== null) {
        return json(
          errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, "Rate limit exceeded.")),
          429,
          { "Retry-After": String(retryAfter) },
        );
      }
    }
    if (!/^application\/json\s*(;|$)/i.test(raw.headers.get("content-type") ?? "")) {
      return new Response("Content-Type must be application/json.", {
        status: 415,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const versionHeader = raw.headers.get("mcp-protocol-version");
    if (versionHeader !== null && !SUPPORTED_VERSIONS.includes(versionHeader)) {
      return json(
        errorResponse(
          null,
          new JsonRpcError(ErrorCode.InvalidRequest, `Unsupported MCP-Protocol-Version: ${versionHeader.slice(0, 40)}`),
        ),
        400,
      );
    }

    // The host's context first: a host with nothing to serve has its body
    // neither read nor parsed.
    const context = this.context ? await this.context(req) : (undefined as C);
    if (context instanceof Response) return context;
    if (context === null) {
      return json(errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, "Not found.")), 404);
    }

    let body: unknown;
    const max = this.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    try {
      body = JSON.parse(await readBody(raw, max));
    } catch (error) {
      if (error instanceof TooLarge) {
        return json(
          errorResponse(null, new JsonRpcError(ErrorCode.InvalidRequest, `The request is larger than ${max} bytes.`)),
          413,
        );
      }
      return json(errorResponse(null, new JsonRpcError(ErrorCode.ParseError, "Parse error.")), 400);
    }

    const id = isObject(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
    try {
      return await this.dispatch(req, context as C, body);
    } catch (error) {
      if (error instanceof McpEndpointError) {
        return json(
          errorResponse(id, new JsonRpcError(error.code, error.message, error.data)),
          error.status,
          error.headers,
        );
      }
      if (error instanceof JsonRpcError) {
        return json(errorResponse(id, error), error.status);
      }
      console.error(`[gemi/mcp] ${this.checked} failed:`, error);
      return json(errorResponse(id, new JsonRpcError(ErrorCode.InternalError, "Internal error.")), 500);
    }
  }

  private async dispatch(req: HttpRequest<any, any>, context: C, body: unknown): Promise<Response> {
    const incoming = classify(body);
    // A notification, or a response to a request this server never sends:
    // accepted, with nothing to answer.
    if (incoming.kind !== "request") return new Response(null, { status: 202 });
    const { message } = incoming;
    const params = message.params ?? {};
    const meta = isObject(params._meta) ? params._meta : {};

    const version = meta[META_PROTOCOL_VERSION];
    const modern = typeof version === "string";
    if (modern) checkModernHeaders(req.rawRequest, message, version);

    const result = await this.answer(req, context, message.method, params, meta, modern);
    return json({ jsonrpc: "2.0", id: message.id, result: modern ? this.complete(result) : result }, 200);
  }

  private async answer(
    req: HttpRequest<any, any>,
    context: C,
    method: string,
    params: Record<string, unknown>,
    meta: Record<string, unknown>,
    modern: boolean,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "initialize": {
        if (modern) break;
        const requested = params.protocolVersion;
        return {
          protocolVersion: (LEGACY_VERSIONS as readonly unknown[]).includes(requested) ? requested : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.serverInfo(),
          ...(this.server?.instructions ? { instructions: this.server.instructions } : {}),
        };
      }
      case "server/discover":
        if (!modern) break;
        return {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          ...(this.server?.instructions ? { instructions: this.server.instructions } : {}),
        };
      case "ping":
        return {};
      case "tools/list": {
        const tools: Record<string, unknown>[] = [];
        for (const [name, tool] of Object.entries(this.tools)) {
          if (await this.offers(tool, context, req)) tools.push(toolJson(name, tool));
        }
        // The list is this host's: cached by the client for this endpoint only.
        return modern ? { tools, ttlMs: 60_000, cacheScope: "private" } : { tools };
      }
      case "tools/call":
        return await this.call(req, context, params, meta);
    }
    throw new JsonRpcError(ErrorCode.MethodNotFound, `Method not found: ${method.slice(0, 100)}`);
  }

  private async call(
    req: HttpRequest<any, any>,
    context: C,
    params: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = params.name;
    const tool = typeof name === "string" && Object.hasOwn(this.tools, name) ? this.tools[name] : undefined;
    // A tool this host does not offer is answered as one there is none of,
    // as its listing leaves it out.
    if (!tool || !(await this.offers(tool, context, req))) {
      throw new JsonRpcError(ErrorCode.InvalidParams, `Unknown tool: ${String(name).slice(0, 100)}`);
    }

    // Spent before the arguments are read, as the twin's middleware spends it
    // before its handler parses the body.
    const retryAfter = await this.spend(req, name as string, tool);
    if (retryAfter !== null) {
      throw new McpEndpointError(-32000, "Rate limit exceeded", {
        status: 429,
        data: { retry_after: retryAfter },
        headers: { "Retry-After": String(retryAfter) },
      });
    }

    let args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) {
      throw new JsonRpcError(ErrorCode.InvalidParams, "arguments must be an object.");
    }
    if (isSchema(tool.inputSchema)) {
      const parsed = tool.inputSchema.safeParse(args);
      if (parsed.ok === false) {
        return {
          content: [{ type: "text", text: `Invalid arguments for "${name}": ${parsed.errors.join(", ")}` }],
          isError: true,
        };
      }
      args = parsed.value;
    }

    let value: unknown;
    try {
      value = await tool.run(args, {
        context,
        req,
        tool: name as string,
        meta,
        signal: req.rawRequest.signal,
      });
    } catch (error) {
      if (error instanceof McpEndpointError || error instanceof JsonRpcError) throw error;
      console.error(`[gemi/mcp] ${this.checked}: "${name}" failed:`, error);
      return { content: [{ type: "text", text: `"${name}" failed on the server.` }], isError: true };
    }
    return toolResult(value);
  }

  private async offers(tool: McpEndpointTool<C>, context: C, req: HttpRequest<any, any>) {
    return tool.offered ? (await tool.offered(context, req)) === true : true;
  }

  /** The tool's budget: the seconds to wait when it is spent, else `null`. */
  private async spend(req: HttpRequest<any, any>, name: string, tool: McpEndpointTool<C>): Promise<number | null> {
    const limit = tool.rateLimit;
    if (limit === undefined) return null;
    if (typeof limit !== "string") {
      return await overBudget(`mcp-endpoint-tool:${clientAddress(req)}:${req.routePath ?? "*"}:${name}`, limit);
    }
    const [, method, path] = TWIN.exec(limit)!;
    const limiters = this.twinLimits(req, name, method, path);
    if (limiters.length === 0) return null;
    // The twin's middleware, run as for a request to the twin: its routePath,
    // and this request's address (the raw request is the same one), so its
    // key, whatever `key` an alias was configured with, is the twin's.
    const twin = new HttpRequest(req.rawRequest, {}, "api", path);
    try {
      await RequestContext.run(twin, async () => {
        for (const { Middleware, params } of limiters) {
          await new Middleware(twin).run(...params);
        }
      });
    } catch (error) {
      if (error instanceof RateLimitExceededError || (error as { name?: string })?.name === "RateLimitExceededError") {
        const ms = (error as RateLimitExceededError).retryAfter ?? 1000;
        return Math.max(1, Math.ceil(ms / 1000));
      }
      throw error;
    }
    return null;
  }

  /**
   * The rate-limit middleware of `method path` in the api of the request's
   * host group. A twin that is not there is the app's mistake, and fails
   * every call of the tool loudly rather than letting it run unlimited.
   */
  private twinLimits(req: HttpRequest<any, any>, name: string, method: string, path: string) {
    const api = app(DOMAIN_ROUTER).dispatchers(req.domain).api;
    const route = api.flatRoutes[path]?.[method];
    if (!route) {
      throw new Error(
        `${this.checked}: tool "${name}" spends the rate limits of ${method} ${path}, and this host's api has no such route. Name the route by its full path, without /api.`,
      );
    }
    return app(MIDDLEWARE)
      .resolve(route.middleware)
      .filter(({ Middleware }) => (Middleware as { isRateLimit?: unknown }).isRateLimit === true) as {
      Middleware: new (req: HttpRequest) => Middleware & { run(...params: string[]): unknown };
      params: string[];
    }[];
  }

  private serverInfo() {
    return { name: this.server?.name ?? "gemi", version: this.server?.version ?? "1.0.0" };
  }

  private complete(result: Record<string, unknown>) {
    return { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: this.serverInfo() } };
  }
}

/**
 * What `this.mcp(Endpoint)` mounts: POST runs the endpoint, GET and DELETE
 * answer 405 (no stream to open, no session to end). `.middleware()` and
 * `.cors()` apply to all three.
 */
export class McpEndpointRoute {
  post: RouteHandler<"POST", any, any, any>;
  get: RouteHandler<"GET", any, any, any>;
  delete: RouteHandler<"DELETE", any, any, any>;

  constructor(endpoint: McpEndpoint<any>) {
    this.post = new RouteHandler("POST", (req: HttpRequest<any, any>) => endpoint.__post(req));
    const notAllowed = (_req: HttpRequest<any, any>) =>
      new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    this.get = new RouteHandler("GET", notAllowed);
    this.delete = new RouteHandler("DELETE", notAllowed);
  }

  middleware(middlewareList: MiddlewareInput) {
    const list = toMiddlewareList(middlewareList);
    for (const handler of [this.post, this.get, this.delete]) handler.middleware(list);
    return this;
  }

  cors(policy: CorsPolicy | false) {
    for (const handler of [this.post, this.get, this.delete]) handler.cors(policy);
    return this;
  }
}

function toolJson(name: string, tool: McpEndpointTool<any>): Record<string, unknown> {
  return {
    name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: isSchema(tool.inputSchema) ? tool.inputSchema.toJSONSchema() : tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations || tool.title
      ? { annotations: { ...(tool.title ? { title: tool.title } : {}), ...tool.annotations } }
      : {}),
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  if (isObject(value) && (value as Partial<ExplicitResult>)[RESULT] === true) {
    const explicit = value as unknown as ExplicitResult;
    return {
      content: [{ type: "text", text: explicit.text ?? textOf(explicit.body) }],
      ...(isObject(explicit.body) ? { structuredContent: explicit.body } : {}),
      isError: explicit.isError,
    };
  }
  if (typeof value === "string") return { content: [{ type: "text", text: value }], isError: false };
  return {
    content: [{ type: "text", text: textOf(value) }],
    // `structuredContent` is an object in every protocol version.
    ...(isObject(value) ? { structuredContent: value } : {}),
    isError: false,
  };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function isSchema(value: unknown): value is AnySchema {
  return (
    isObject(value) &&
    typeof (value as { safeParse?: unknown }).safeParse === "function" &&
    typeof (value as { toJSONSchema?: unknown }).toJSONSchema === "function"
  );
}

function isBudget(value: unknown): value is { limit: number; window: number } {
  return (
    isObject(value) &&
    typeof value.limit === "number" &&
    value.limit > 0 &&
    Number.isFinite(value.limit) &&
    typeof value.window === "number" &&
    value.window > 0 &&
    Number.isFinite(value.window)
  );
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

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

