import type { ToolContext } from "../../ai/Agent";
import type { User } from "../../auth/types";
import { safeFetch, type SafeFetchOptions } from "../../http/safeFetch";
import { ToolError } from "../../ai/redact";
import { s, type AnySchema, type JSONSchema, type Schema } from "../../ai/Schema";
import type { RouteSource } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import type {
  McpFileBinder,
  McpMethod,
  McpModelParam,
  McpParamBinder,
  McpResultProjection,
  McpRouteDeclaration,
  McpRouter,
} from "../../http/McpRouter";
import type {
  ApiRouteDispatcher,
  DispatchAsOptions,
  DispatchCredentials,
} from "../router/ApiRouteDispatcher";

/**
 * Who a tool call runs as. Always an argument to the registry, never read from
 * ambient state by it.
 *
 * `local` is an agent running in this server, and `req` is the request that
 * started its run — read by `toAgentTools` at the moment the tool executes,
 * not when the tool was built, which is what lets one set of tools serve every
 * user's run.
 *
 * That producer *does* read ambient state, since a run no longer carries a
 * request (see `AgentContext`), and the boundary is what keeps that from
 * mattering here: the registry is handed a caller and dispatches as that
 * caller, so a second producer — a job, a test, the remote transport —
 * supplies one however it likes, and a run with no ambient request is refused
 * by `toAgentTools` before the registry is reached rather than dispatching as
 * nobody.
 * The call is dispatched with that request's credentials, so it runs as that
 * user, through that route's middleware.
 *
 * `remote` is an MCP client over HTTP (#762). `req` is its request to the MCP
 * endpoint, and `principal` is what a caller resolver made of the credential
 * it carried — an OAuth access token or an app API key — after verifying it.
 * Nothing of the request's own credentials is forwarded: the call is
 * dispatched as `principal.user`, set on the route's request context before
 * its middleware runs, so `auth`, policies and the route's own checks decide
 * exactly as they would for that user's direct request. See
 * `ApiRouteDispatcher.dispatchAs`'s `identity`.
 */
export type McpCaller =
  | { kind: "local"; req: HttpRequest<any, any> }
  | { kind: "remote"; req: HttpRequest<any, any>; principal: McpRemotePrincipal };

/**
 * A remote caller, as a resolver verified it.
 *
 * Built only by a resolver, from a credential it checked — never from what a
 * client says about itself.
 */
export type McpRemotePrincipal = {
  /** The user every call runs as. */
  user: User;
  /** Which resolver vouched for the credential: `"oauth"`, `"api-key"`, or an app's own. */
  via: string;
  /**
   * A stable id for the credential: the OAuth grant, the API key. Not the
   * secret itself. Keys the rate-limit budget the caller's tool calls spend,
   * and is what a log line names.
   */
  id: string;
  /** The scopes the credential carries. Decides which tools the caller sees. */
  scopes: readonly string[];
  /** The OAuth client the token was issued to, when there is one. */
  clientId?: string;
};

/**
 * One scope a remote credential can carry, as an `McpRouter` declares it: the
 * tools it reaches, by tag and by name, and the sentence a consent screen
 * shows for it.
 */
export type McpScope = {
  /** What a user is agreeing to, in their words: "Read and edit your site's pages". */
  description: string;
  /** Every tool carrying one of these tags. */
  tags?: readonly string[];
  /** These tools, by name. */
  names?: readonly string[];
};

/**
 * The scope a router without `scopes` gets: every tool it declares. A router
 * that wants a credential to reach only some of them declares its own.
 */
export const DEFAULT_MCP_SCOPE = "mcp";

/** RFC 6749's scope-token: printable ASCII, no space, `"` or `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** How a remote caller's file arguments are read. */
export type McpRemoteFileOptions = {
  /** The largest file accepted, in bytes, decoded. Default 10 MiB. */
  maxBytes?: number;
  /**
   * Lets a remote caller name a file by an `https` URL, fetched through
   * `safeFetch` — public addresses only, no credentials sent, bounded in size
   * and time. Off by default: a URL argument makes the server fetch whatever
   * the model was steered to name. `true` takes `safeFetch`'s defaults; an
   * object is passed to it (`allow` a list of hosts, say), with `maxSize`
   * capped at `maxBytes`.
   */
  fetchUrls?: boolean | SafeFetchOptions;
};

/** What `McpRegistry` takes beside the router and the dispatcher. */
export type McpRegistryOptions = {
  /** Remote callers' file arguments. See `McpRemoteFileOptions`. */
  files?: McpRemoteFileOptions;
};

/** What `execute` takes beside the call itself. */
export type McpExecuteOptions = {
  /**
   * That the user approved this call, for a tool with `requiresApproval`.
   * The remote transport sets it after an elicitation the user accepted; a
   * remote call to such a tool without it is refused, so a transport that
   * forgot to ask fails closed. Local calls are approved by the agent loop
   * before `execute` is reached, and ignore it.
   */
  approved?: boolean;
};

/**
 * One tool call, as the app's hooks see it: who is calling, the request their
 * identity comes from, which tool, its parsed arguments, and — for a call an
 * agent run makes — the run's tool context.
 *
 * `req` is `caller.req`, repeated so a hook that only wants the request does
 * not have to narrow the caller. For a remote caller it is the request to the
 * MCP endpoint, run inside a request context whose user is
 * `caller.principal.user`, so `req.ctx().user` names the same user for both
 * callers. `ctx` is absent for a remote caller, and when `McpRegistry.execute`
 * is called without one (a test, a script dispatching a tool directly).
 */
export type McpCallContext = {
  caller: McpCaller;
  req: HttpRequest<any, any>;
  tool: McpToolDescriptor;
  input: Record<string, unknown>;
  ctx?: ToolContext;
};

/**
 * What `McpRouter.credentials` answers for a call: the app's own headers and
 * cookies, sent beside gemi's access token. See `DispatchCredentials`.
 */
export type McpCredentials = DispatchCredentials;

/**
 * MCP's tool annotations. They drive confirmation prompts in remote clients,
 * which is why they are set from v1 on rather than when the remote caller
 * lands: every app would otherwise have to revisit its MCP file to get them.
 *
 * The verb sets the defaults, and only what it says: GET is read-only, DELETE
 * destructive, PUT idempotent. POST and PATCH carry nothing, and MCP's
 * defaults for an unannotated tool — not read-only, possibly destructive — are
 * the honest answer for them. A route meta's `annotations` overrides them hint
 * by hint (#760), `false` included.
 *
 * `destructiveHint` and `idempotentHint` only mean something for a tool that
 * is not read-only, so a tool left read-only with either set is refused at
 * boot: one of the two is a mistake, and a client would read the wrong one.
 */
export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** Whether the tool reaches beyond the app's own data — a third-party API, the web. */
  openWorldHint?: boolean;
};

/**
 * One tool, described without committing to who consumes it.
 *
 * The registry's native output. An in-process agent projects it to an
 * `AgentTool` (`toAgentTools`); v2's `tools/list` will project it to JSON.
 * Emitting `AgentTool`s here instead would leave v2 reversing JSON Schema back
 * out of them.
 */
export interface McpToolDescriptor {
  /** The `routes` key, verbatim. See `McpRouter`. */
  readonly name: string;
  readonly description: string;
  readonly method: McpMethod;
  /** The route's path as declared, params unfilled. */
  readonly url: string;
  /**
   * What the model fills in: the declared `input`, plus a string for every
   * `"input"` path param and every `"input"` file field, and the model-facing
   * field of every `this.param(...)` (#767), under its own name and schema.
   * Bound params and bound files are not in it at all, and neither is the raw
   * name of a param the model names in its own terms.
   */
  readonly inputSchema: Schema<Record<string, unknown>>;
  /**
   * The route meta's `output`: the shape of what the tool answers, after
   * `result`. Absent when the meta declares none. v2's `tools/list` emits it
   * as `outputSchema`.
   */
  readonly outputSchema?: AnySchema;
  /** The meta's `title`: a name for a client to show. Absent when it declares none. */
  readonly title?: string;
  readonly annotations: Readonly<McpToolAnnotations>;
  readonly tags: readonly string[];
  readonly requiresApproval: boolean;
  /** The controller method mounted at the route, when there is one (#502). */
  readonly source?: RouteSource;
}

/**
 * Narrows `list`. Data rather than a predicate, because v2's per-token
 * visibility will come from a token's grants, which are data. Both fields
 * narrow: `names` keeps only those tools, `tags` keeps tools carrying at least
 * one of them.
 */
export type McpToolFilter = {
  names?: readonly string[];
  tags?: readonly string[];
};

/**
 * A failure the model is meant to read: a 4xx from the route, a missing file,
 * a bad argument. v2 turns it into `isError: true` rather than a protocol
 * error. Anything else thrown from `execute` is the caller's mistake or the
 * server's, not the model's.
 */
export class McpToolError extends ToolError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * A remote call the transport must not run as asked: a tool the caller cannot
 * see, or one that needs the user's approval and does not have it. Not a
 * `ToolError` — it is the transport's to handle, not the model's to read.
 */
export class McpCallRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown-tool" | "approval-required",
  ) {
    super(message);
    this.name = "McpCallRefusedError";
  }
}

/** Tool names as OpenAI's function tools and MCP clients both accept them. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** `:name`, with URLPattern's modifiers. */
const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)([?*+]?)/g;

/**
 * A 4xx body goes to the model verbatim, so a validation error can be fixed on
 * the next step — but a route that answers a 4xx with a page of HTML should not
 * be able to fill the context window with it.
 */
const MAX_ERROR_BODY = 4000;

/**
 * The same limit for a success, set higher: a list route answering every row,
 * or a route serving a large text file, would otherwise land in the context
 * window whole. Past it the model gets the text cut short and told so, rather
 * than an error — the route has already done what it does, and a model told it
 * failed would do it again.
 */
const MAX_RESULT_BODY = 100_000;

/** A body a model can read. A missing content-type is read as text. */
const READABLE = /^(text\/|application\/([\w.+-]*\+)?(json|xml))/i;

type PathParam = { name: string; modifier: string };

type Plan = {
  descriptor: McpToolDescriptor;
  /**
   * The same tool as a remote caller sees it: its `"input"` files are a file
   * object (`name`, `mimeType`, and base64 `data` or a `url`) rather than an
   * attachment id, since a remote client has no attachment store. `null` when
   * the tool cannot be called remotely at all — it has a bound file, whose
   * binder needs the run's tool context.
   */
  remote: McpToolDescriptor | null;
  params: PathParam[];
  paramBinders: Map<string, McpParamBinder>;
  /** Params the model names in its own terms: the input key, and the resolver. */
  modelParams: Map<string, { key: string; param: McpModelParam<any, any> }>;
  fileFields: { name: string; binder: McpFileBinder | "input" }[];
  jsonKeys: string[];
  result?: McpResultProjection;
};

/**
 * The tools an app's `McpRouter` declares, resolved against the api route
 * table, and the one place a call to them is dispatched.
 *
 * Built once, at boot, from the dispatcher's flat route table — so a route
 * that was renamed or unmounted fails the boot here, and at compile time
 * before that, rather than the first model that calls it.
 *
 * THE INVARIANT: a tool call can do nothing its caller could not do with a
 * direct HTTP request. `execute` builds a request and hands it to
 * `ApiRouteDispatcher.dispatchAs`, which runs the route's middleware, auth and
 * policies exactly as for a client. It never reaches for a flat entry's
 * `exec`, which is the handler alone — no auth, no policies, no rate limit —
 * and is the shorter path for exactly that reason.
 */
export class McpRegistry<R extends McpRouter<any> = McpRouter<any>> {
  static token = "router.mcp";

  /**
   * Types only, never set: the app's router, which a typed `toAgentTools`
   * reads its tools' names, inputs and outputs from (#771). The container
   * answers an untyped registry; name the router where the tools are built:
   * `app(McpRegistry) as McpRegistry<SiteMcpRouter>`.
   */
  declare readonly __router?: R;

  private readonly plans = new Map<string, Plan>();
  /** Each scope, resolved to the names of the tools it reaches. */
  private readonly scopeTools = new Map<string, { description: string; tools: Set<string> }>();
  private readonly files: { maxBytes: number; fetch: SafeFetchOptions | null };

  constructor(
    private readonly router: McpRouter<any>,
    private readonly dispatcher: Pick<
      ApiRouteDispatcher,
      "flatRoutes" | "dispatchAs" | "getRouteHandlerAndParams"
    >,
    options: McpRegistryOptions = {},
  ) {
    this.files = remoteFileOptions(options.files);
    for (const [name, declaration] of Object.entries(router.routes ?? {})) {
      this.plans.set(name, this.plan(name, declaration));
    }
    this.resolveScopes();
  }

  /**
   * The tools `caller` may see, narrowed by `filter`.
   *
   * A local caller sees every declared tool. A remote one sees the tools a
   * scope it carries reaches, as it can call them (see `Plan.remote`): a
   * credential that carries no scope sees nothing, and a tool no scope reaches
   * is never listed remotely. Visibility is checked again by `execute`, so a
   * client naming a tool it was not shown gets what it would for a tool that
   * does not exist.
   */
  list(caller: McpCaller, filter?: McpToolFilter): McpToolDescriptor[] {
    assertCaller(caller);
    if (caller.kind === "local") return this.descriptors(filter);
    const out: McpToolDescriptor[] = [];
    for (const [name, plan] of this.plans) {
      if (!plan.remote || !this.grants(caller.principal, name)) continue;
      if (passes(plan.remote, filter)) out.push(plan.remote);
    }
    return out;
  }

  /**
   * The same listing without a caller, for a projection built once before any
   * caller exists — `toAgentTools`. It is not per-caller visibility, and a
   * remote listing must go through `list`.
   */
  descriptors(filter?: McpToolFilter): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = [];
    for (const { descriptor } of this.plans.values()) {
      if (passes(descriptor, filter)) out.push(descriptor);
    }
    return out;
  }

  /**
   * The scopes a remote credential can carry, with what each one is for —
   * what a consent screen lists and the authorization server advertises. The
   * router's `scopes`, or `DEFAULT_MCP_SCOPE` reaching every tool when it
   * declares none.
   */
  scopes(): { name: string; description: string }[] {
    return [...this.scopeTools].map(([name, { description }]) => ({ name, description }));
  }

  /**
   * The scopes that reach the tool `name`: what a client missing all of them
   * has to ask for. Empty for a tool no scope reaches, or none by that name.
   */
  scopesFor(name: string): string[] {
    return [...this.scopeTools].filter(([, { tools }]) => tools.has(name)).map(([scope]) => scope);
  }

  /**
   * Calls the tool `name` as `caller`, and answers the route's JSON.
   *
   * Before dispatching, the router's `credentials` hook, when it has one, is
   * asked for the app's own headers and cookies for this call; they ride
   * beside the access token (see `McpRouter.credentials`). A throw from it is a
   * server failure, logged for the app, like a binder's.
   *
   * `ctx` is the tool context of the agent call, and only files need it:
   * `"input"` files resolve through `ctx.attachments`, the handle already
   * scoped to the caller, and bound files are chosen by a binder given `ctx`.
   * Nothing here reads an attachment any other way — the store has no
   * unscoped lookup, and this must not become one.
   *
   * A remote caller has neither a tool context nor attachments. It is held to
   * the tools its scopes reach, and to `requiresApproval` (see
   * `McpExecuteOptions.approved`): either refusal is an
   * `McpCallRefusedError`, for the transport. Its files arrive in the
   * arguments, as base64 or — when the app allows it — an `https` URL.
   *
   * A 2xx answers its JSON, or its text, cut at `MAX_RESULT_BODY`; a body
   * that is neither — a file a route serves — is described, not shown. A tool
   * whose meta has a `result` or an `output` answers its JSON put through
   * them instead, and is cut after that, not before (see `project`).
   * A 4xx throws an `McpToolError` carrying the route's body, so a validation
   * error reaches the model word for word. Anything else, or a route that
   * throws, throws an `McpToolError` that says only that the server failed.
   * The app gets the reason in its log, and a stack trace or a database
   * message is not something to hand a model that may be steered by whoever
   * wrote the document it is reading.
   */
  async execute(
    caller: McpCaller,
    name: string,
    args: unknown,
    ctx?: ToolContext,
    options: McpExecuteOptions = {},
  ): Promise<unknown> {
    assertCaller(caller);
    const found = this.plans.get(name);
    if (caller.kind === "remote") {
      // Worded like a tool that does not exist, so a client cannot tell a
      // tool it may not see from one there is none of.
      if (!found?.remote || !this.grants(caller.principal, name)) {
        throw new McpCallRefusedError(`There is no tool named "${name}".`, "unknown-tool");
      }
      if (found.descriptor.requiresApproval && options.approved !== true) {
        throw new McpCallRefusedError(
          `"${name}" needs the user's approval, and this call does not have it.`,
          "approval-required",
        );
      }
      // Never handed to a remote call, even if a transport passed one: its
      // attachments are scoped to somebody's run, not to this caller.
      ctx = undefined;
    }
    if (!found) {
      throw new Error(`McpRegistry: there is no tool named "${name}".`);
    }
    const plan = found;
    const descriptor = caller.kind === "remote" ? plan.remote! : plan.descriptor;

    const parsed = descriptor.inputSchema.safeParse(args);
    if (parsed.ok === false) {
      throw new McpToolError(`Invalid arguments for "${name}": ${parsed.errors.join(", ")}`);
    }
    const input = parsed.value;

    const call: McpCallContext = { caller, req: caller.req, tool: descriptor, input, ctx };
    const path = await this.fillPath(plan, call);

    // The dispatcher routes `path` afresh and takes the first route that
    // matches it, so a model's "archive-all" for `/products/:id` would reach a
    // `/products/archive-all` declared above it — a route the app never
    // exposed, behind none of this tool's approval or annotations.
    const { path: matched } = this.dispatcher.getRouteHandlerAndParams(
      new Request(`http://gemi.internal/api${path}`),
    );
    if (matched !== descriptor.url) {
      throw new McpToolError(`"${name}" has nothing at ${path}.`, 404);
    }

    const json: Record<string, unknown> = {};
    for (const key of plan.jsonKeys) {
      if (input[key] !== undefined) json[key] = input[key];
    }

    let body: FormData | Record<string, unknown> | undefined;
    let query = "";
    if (plan.fileFields.length > 0) {
      body = await this.formData(plan, json, call);
    } else if (descriptor.method === "GET") {
      query = toQuery(json);
    } else if (plan.jsonKeys.length > 0) {
      body = json;
    }

    const credentials = this.router.credentials
      ? await this.bind(plan, "the credentials", () => this.router.credentials!(call))
      : undefined;

    // A remote caller is dispatched as the user its resolver verified, and
    // nothing of its own request's credentials crosses over: its bearer token
    // is for this server's MCP endpoint, and passing it on would be the token
    // passthrough the MCP authorization spec forbids.
    const dispatchOptions: DispatchAsOptions = {
      ...(credentials ? { credentials } : {}),
      ...(caller.kind === "remote"
        ? {
            identity: {
              user: caller.principal.user,
              grant: {
                via: caller.principal.via,
                id: caller.principal.id,
                scopes: caller.principal.scopes,
                ...(caller.principal.clientId ? { clientId: caller.principal.clientId } : {}),
              },
            },
          }
        : {}),
    };

    let response: Response;
    try {
      const target = query ? `${path}?${query}` : path;
      response =
        Object.keys(dispatchOptions).length > 0
          ? await this.dispatcher.dispatchAs(
              caller.req,
              descriptor.method,
              target,
              body,
              dispatchOptions,
            )
          : await this.dispatcher.dispatchAs(caller.req, descriptor.method, target, body);
    } catch (error) {
      // What a client would get as a 500. A handler's throw is logged by the
      // dispatcher too, but dispatchAs's own refusal of the path is not.
      console.error(`[gemi/mcp] Dispatching "${name}" failed:`, error);
      throw new McpToolError(`"${name}" failed on the server.`, 500);
    }
    if (!plan.result && !descriptor.outputSchema) {
      return await readResponse(name, response);
    }
    return await this.project(plan, call, response);
  }

  // --- building ------------------------------------------------------------

  private plan(name: string, declaration: McpRouteDeclaration): Plan {
    if (!TOOL_NAME.test(name)) {
      throw new Error(
        `McpRouter: "${name}" is not a valid tool name. A routes key is the tool's name as a model and an MCP client see it, used verbatim — letters, digits, "_" and "-", at most 64.`,
      );
    }
    const where = `McpRouter: "${name}" (${declaration?.method} ${declaration?.url})`;
    if (!(declaration instanceof Object) || declaration.__internal_brand !== "McpRoute") {
      throw new Error(
        `McpRouter: "${name}" is not a route. Declare it with this.fromApiRoute(...).`,
      );
    }
    const { method, url, meta } = declaration;
    if (url.startsWith("/__gemi__")) {
      throw new Error(`${where} is a framework route, not an app route.`);
    }

    const entry = this.dispatcher.flatRoutes[url]?.[method];
    if (!entry) {
      throw new Error(
        `${where} names no route of this app. Expose a route by the path and verb it is mounted at.`,
      );
    }

    // Mirrors the compile-time check, for a router written in JavaScript or
    // behind a cast: a param left undeclared would otherwise be the model's.
    const params: PathParam[] = [...url.matchAll(PATH_PARAM)].map(([, param, modifier]) => ({
      name: param,
      modifier,
    }));
    const declared = meta.params ?? {};
    for (const param of params) {
      if (!(param.name in declared)) {
        throw new Error(
          `${where}: the path param "${param.name}" must be bound or declared "input".`,
        );
      }
    }
    for (const [key, binder] of Object.entries(declared)) {
      if (!params.some((param) => param.name === key)) {
        throw new Error(`${where}: "${key}" in params is not a param of the url.`);
      }
      if (isModelParam(binder)) {
        assertModelParam(where, `params.${key}`, binder);
      } else {
        assertBinder(where, `params.${key}`, binder);
      }
    }

    let jsonKeys: string[] = [];
    let base: JSONSchema | undefined;
    if (meta.input) {
      base = meta.input.toJSONSchema();
      if (base.type !== "object" || !base.properties) {
        throw new Error(
          `${where}: input must be an s.object(...), the fields of the request body.`,
        );
      }
      jsonKeys = Object.keys(base.properties);
    }

    const fileFields = Object.entries(meta.files ?? {}).map(([field, binder]) => ({
      name: field,
      binder,
    }));
    for (const file of fileFields) {
      assertBinder(where, `files.${file.name}`, file.binder);
    }
    if (meta.result !== undefined && typeof meta.result !== "function") {
      throw new Error(`${where}: result must be a function.`);
    }
    if (meta.output !== undefined && typeof meta.output?.safeParse !== "function") {
      throw new Error(`${where}: output must be a schema, built with s.`);
    }
    if (meta.title !== undefined && (typeof meta.title !== "string" || meta.title === "")) {
      throw new Error(`${where}: title must be a non-empty string.`);
    }
    const annotations = annotationsFor(where, method, meta.annotations);
    if (fileFields.length > 0 && method === "GET") {
      throw new Error(`${where}: a GET has no body to carry a file.`);
    }

    const extras: Record<string, AnySchema> = {};
    // Two params, or a param and a file, can name the same input key only by
    // a `this.param` `as`; the model could send one value for both.
    const addExtra = (key: string, schema: AnySchema) => {
      if (key in extras) {
        throw new Error(
          `${where}: "${key}" is the input key of two params or files, and the model can only send one.`,
        );
      }
      extras[key] = schema;
    };
    const paramBinders = new Map<string, McpParamBinder>();
    const modelParams = new Map<string, { key: string; param: McpModelParam<any, any> }>();
    for (const param of params) {
      const binder = declared[param.name];
      if (binder === "input") {
        const field = s.string().describe(`The ":${param.name}" segment of the url.`);
        addExtra(
          param.name,
          param.modifier === "?" || param.modifier === "*" ? field.optional() : field,
        );
      } else if (isModelParam(binder)) {
        const key = binder.as ?? param.name;
        addExtra(key, binder.input);
        modelParams.set(param.name, { key, param: binder });
      } else {
        paramBinders.set(param.name, binder);
      }
    }
    // A remote caller sends what a local one sends, except for its files: it
    // has no attachments to name, so it sends the file itself.
    const remoteFiles: Record<string, AnySchema> = {};
    for (const file of fileFields) {
      if (file.binder === "input") {
        addExtra(
          file.name,
          s
            .string()
            .describe(
              "The id of an attachment the user uploaded or a tool produced (gemi_att_…), whose file is sent as this field.",
            ),
        );
        remoteFiles[file.name] = this.remoteFileSchema();
      }
    }
    // A bound file is not the model's, but it shares the form with the input,
    // so it collides all the same.
    const bodyKeys = [...Object.keys(extras), ...fileFields.map((file) => file.name)];
    for (const key of new Set(bodyKeys)) {
      if (jsonKeys.includes(key)) {
        throw new Error(
          `${where}: "${key}" is both an input field and a param or file, and the model can only send one.`,
        );
      }
    }

    const descriptor: McpToolDescriptor = Object.freeze({
      name,
      description: meta.description,
      method,
      url,
      inputSchema: combineSchemas(meta.input, base, s.object(extras)),
      ...(meta.output ? { outputSchema: meta.output } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      annotations,
      tags: Object.freeze([...(meta.tags ?? [])]),
      requiresApproval: meta.requiresApproval === true,
      ...(entry.source ? { source: entry.source } : {}),
    });
    const remotelyCallable = fileFields.every((file) => file.binder === "input");
    const remote = !remotelyCallable
      ? null
      : fileFields.length === 0
        ? descriptor
        : Object.freeze({
            ...descriptor,
            inputSchema: combineSchemas(
              meta.input,
              base,
              s.object(withoutKeys(extras, Object.keys(remoteFiles))),
              remoteFiles,
            ),
          });

    return {
      descriptor,
      remote,
      params,
      paramBinders,
      modelParams,
      fileFields,
      jsonKeys,
      ...(meta.result ? { result: meta.result } : {}),
    };
  }

  /**
   * What a remote caller sends for a file field: `{ name, mimeType, data }`,
   * or `{ name, mimeType, url }` when the app fetches URLs.
   *
   * Built by hand, as `combineSchemas` is, rather than with `s`: `s` writes
   * the strict structured-output form, where an optional field is a required
   * one that may be `null`, and an MCP client validating its arguments
   * against that would demand `data` and `url` both. Exactly one of the two is
   * checked when the file is read (`remoteFile`), where the refusal can say
   * so.
   */
  private remoteFileSchema(): AnySchema {
    const { maxBytes, fetch } = this.files;
    // `contentEncoding` and `format` are JSON Schema 2020-12 keywords the
    // builder's own type does not name; they are hints for the client.
    const properties: Record<string, JSONSchema & Record<string, unknown>> = {
      name: { type: "string", description: "The file's name, like report.pdf." },
      mimeType: { type: "string", description: "The file's media type, like application/pdf." },
      data: {
        type: "string",
        contentEncoding: "base64",
        description: `The file's bytes, base64-encoded (RFC 4648, standard alphabet). At most ${maxBytes} bytes decoded.`,
      },
    };
    if (fetch) {
      properties.url = {
        type: "string",
        format: "uri",
        description: "An https URL the server downloads the file from, instead of data.",
      };
    }
    const json: JSONSchema = {
      type: "object",
      description: fetch
        ? "A file, sent as base64 in data or fetched from url: exactly one of the two."
        : "A file, sent as base64 in data.",
      properties,
      required: ["name", "mimeType"],
      additionalProperties: false,
    };
    const keys = Object.keys(properties);
    const safeParse = (value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false as const, errors: ["a file must be an object"] };
      }
      const errors: string[] = [];
      const out: Record<string, string> = {};
      for (const key of Object.keys(value)) {
        if (!keys.includes(key)) errors.push(`a file has no field "${key}"`);
      }
      for (const key of keys) {
        const field = (value as Record<string, unknown>)[key];
        if (field === undefined || field === null) {
          if (key === "name" || key === "mimeType") errors.push(`a file needs "${key}"`);
          continue;
        }
        if (typeof field !== "string") errors.push(`a file's "${key}" must be a string`);
        else out[key] = field;
      }
      return errors.length > 0 ? { ok: false as const, errors } : { ok: true as const, value: out };
    };
    return {
      toJSONSchema: () => json,
      safeParse,
      parse(value: unknown) {
        const result = safeParse(value);
        if (result.ok === false) throw new Error(result.errors.join(", "));
        return result.value;
      },
    } as unknown as AnySchema;
  }

  // --- calling -------------------------------------------------------------

  private async fillPath(plan: Plan, call: McpCallContext): Promise<string> {
    const { input, req } = call;
    let path = plan.descriptor.url;
    for (const param of plan.params) {
      const binder = plan.paramBinders.get(param.name);
      const modelParam = plan.modelParams.get(param.name);
      let value: unknown;
      if (binder || modelParam) {
        value = modelParam
          ? await this.bind(
              plan,
              `the param "${param.name}"`,
              () => modelParam.param.bind(input[modelParam.key], req, call),
              { refusals: true },
            )
          : await this.bind(plan, `the param "${param.name}"`, () => binder!(req, call));
        if (value === undefined || value === null || value === "") {
          console.error(
            `[gemi/mcp] The ${modelParam ? "resolver" : "binder"} for "${param.name}" of "${plan.descriptor.name}" returned ${JSON.stringify(value)}.`,
          );
          throw new McpToolError(`"${plan.descriptor.name}" failed on the server.`, 500);
        }
      } else {
        value = input[param.name];
      }

      const token = `:${param.name}${param.modifier}`;
      if (value === undefined || value === null || value === "") {
        if (param.modifier !== "?" && param.modifier !== "*") {
          throw new McpToolError(`"${param.name}" of "${plan.descriptor.name}" must not be empty.`);
        }
        path = path.replace(`/${token}`, "");
        continue;
      }
      path = path.replace(token, encodeSegment(plan.descriptor.name, param, String(value)));
    }
    return path;
  }

  private async formData(
    plan: Plan,
    json: Record<string, unknown>,
    call: McpCallContext,
  ): Promise<FormData> {
    const { input, ctx } = call;
    const name = plan.descriptor.name;
    if (call.caller.kind === "remote") {
      const form = new FormData();
      for (const [key, value] of Object.entries(json)) {
        appendField(form, key, value);
      }
      for (const field of plan.fileFields) {
        form.append(field.name, await this.remoteFile(name, field.name, input[field.name]));
      }
      return form;
    }
    if (!ctx) {
      throw new Error(
        `McpRegistry: "${name}" sends a file, which is resolved through the tool context's attachments, and none was passed to execute().`,
      );
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(json)) {
      appendField(form, key, value);
    }
    for (const field of plan.fileFields) {
      const id =
        field.binder === "input"
          ? (input[field.name] as string)
          : await this.bind(plan, `the file "${field.name}"`, () =>
              (field.binder as McpFileBinder)(ctx, call),
            );
      if (typeof id !== "string" || id === "") {
        throw new McpToolError(
          `"${name}" needs a file for "${field.name}", and this turn has none. Ask the user to attach one.`,
        );
      }
      // Scoped to the caller: someone else's id is a not-found, worded like an
      // invented one, and that error is what the model reads.
      form.append(field.name, await ctx.attachments.file(id));
    }
    return form;
  }

  /**
   * A remote caller's file argument, as a `File`: its base64 `data` decoded,
   * or its `url` fetched through `safeFetch` when the app allows that. Every
   * refusal is the model's to read and correct — a file too large, data that
   * is not base64, a URL that is not `https` or not reachable — since it is
   * about what the model sent, not about the server.
   */
  private async remoteFile(tool: string, field: string, value: unknown): Promise<File> {
    const refuse = (why: string) =>
      new McpToolError(`"${field}" of "${tool}" ${why}`, 400);
    const file = value as { name: string; mimeType: string; data?: string; url?: string };
    const { maxBytes, fetch: fetchOptions } = this.files;
    if (!isSafeFileName(file.name)) {
      throw refuse("needs a name of 1 to 255 characters, without control characters or slashes.");
    }
    if (!MEDIA_TYPE.test(file.mimeType)) {
      throw refuse(`has a mimeType that is not a media type: "${file.mimeType.slice(0, 100)}".`);
    }
    const hasData = typeof file.data === "string";
    const hasUrl = typeof file.url === "string";
    if (hasData === hasUrl) {
      throw refuse(
        fetchOptions ? "needs exactly one of data or url." : "needs its bytes, base64, in data.",
      );
    }
    if (hasData) {
      const data = file.data!.replace(/\s+/g, "");
      // Checked before decoding, so an oversized argument is never turned
      // into a buffer. `Buffer.from(…, "base64")` skips what it cannot read
      // rather than failing, so the alphabet is checked first too.
      if (Math.floor((data.length * 3) / 4) - padding(data) > maxBytes) {
        throw refuse(`is larger than the ${maxBytes} bytes a file may be.`);
      }
      if (data.length % 4 !== 0 || !BASE64.test(data)) {
        throw refuse("has data that is not base64 (RFC 4648, standard alphabet, padded).");
      }
      return new File([Buffer.from(data, "base64")], file.name, { type: file.mimeType });
    }
    if (!fetchOptions) {
      throw refuse("cannot be fetched from a URL here. Send its bytes, base64, in data.");
    }
    let url: URL;
    try {
      url = new URL(file.url!);
    } catch {
      throw refuse("has a url that is not a URL.");
    }
    if (url.protocol !== "https:") {
      throw refuse("can only be fetched from an https URL.");
    }
    try {
      const response = await safeFetch(url.href, {
        ...fetchOptions,
        maxSize: Math.min(fetchOptions.maxSize ?? maxBytes, maxBytes),
        redirect: "follow",
      });
      if (!response.ok) {
        throw refuse(`could not be fetched: ${url.host} answered ${response.status}.`);
      }
      const bytes = await response.arrayBuffer();
      return new File([bytes], file.name, { type: file.mimeType });
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      // safeFetch's errors say what was refused (a private address, too large,
      // a timeout) without anything the model should not see.
      throw refuse(
        `could not be fetched from ${url.host}: ${error instanceof Error ? error.message : "failed"}.`,
      );
    }
  }

  /** Whether a remote principal carries a scope that reaches the tool `name`. */
  private grants(principal: McpRemotePrincipal, name: string): boolean {
    for (const scope of principal.scopes ?? []) {
      if (this.scopeTools.get(scope)?.tools.has(name)) return true;
    }
    return false;
  }

  /**
   * The router's `scopes`, each resolved to tool names once, at boot. A tag or
   * name no tool has is refused, since it is a typo that would leave a scope
   * reaching less than its description promises; so is a scope that reaches
   * nothing, and a name a scope token cannot be.
   */
  private resolveScopes() {
    const declared = this.router.scopes;
    if (declared === undefined) {
      this.scopeTools.set(DEFAULT_MCP_SCOPE, {
        description: "Use this app's tools as you",
        tools: new Set(this.plans.keys()),
      });
      return;
    }
    if (typeof declared !== "object" || declared === null) {
      throw new Error("McpRouter: scopes must be an object of scope names.");
    }
    const tags = new Set([...this.plans.values()].flatMap(({ descriptor }) => descriptor.tags));
    for (const [scope, spec] of Object.entries(declared as Record<string, McpScope>)) {
      const where = `McpRouter: scope "${scope}"`;
      if (!SCOPE_TOKEN.test(scope)) {
        throw new Error(`${where} is not a valid OAuth scope: printable ASCII, no spaces or quotes.`);
      }
      if (typeof spec?.description !== "string" || spec.description === "") {
        throw new Error(`${where} needs a description: it is what a consent screen shows.`);
      }
      const tools = new Set<string>();
      for (const tag of spec.tags ?? []) {
        if (!tags.has(tag)) throw new Error(`${where} names the tag "${tag}", which no tool has.`);
        for (const [name, { descriptor }] of this.plans) {
          if (descriptor.tags.includes(tag)) tools.add(name);
        }
      }
      for (const name of spec.names ?? []) {
        if (!this.plans.has(name)) throw new Error(`${where} names "${name}", which is no tool.`);
        tools.add(name);
      }
      if (tools.size === 0) {
        throw new Error(`${where} reaches no tool. Give it tags or names.`);
      }
      this.scopeTools.set(scope, { description: spec.description, tools });
    }
  }

  /**
   * A 2xx put through the meta's `result` and `output`, for a tool that has
   * either.
   *
   * The whole body is parsed and projected before anything is cut: trimming a
   * large answer down is what a projection is for, and cutting first would
   * hand `result` half a JSON document. The projected value is then held to
   * `MAX_RESULT_BODY` the way any answer is.
   *
   * Every failure here is the app's, not the model's — a route that answered
   * something other than JSON, a `result` that threw, an answer `output` does
   * not describe — so each is logged and the model is told only that the
   * tool failed. Telling it more would invite a retry of a call that already
   * did what it does.
   */
  private async project(plan: Plan, call: McpCallContext, response: Response): Promise<unknown> {
    const { name, outputSchema } = plan.descriptor;
    if (response.status < 200 || response.status >= 300) {
      return await readResponse(name, response);
    }
    const failed = (why: string, error?: unknown) => {
      if (error === undefined) console.error(`[gemi/mcp] "${name}" ${why}`);
      else console.error(`[gemi/mcp] "${name}" ${why}`, error);
      return new McpToolError(`"${name}" failed on the server.`, 500);
    };

    const type = response.headers.get("Content-Type");
    const text = await response.text();
    let data: unknown = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        throw failed(
          `answered ${type ?? "a body with no content-type"} that is not JSON, and its result or output needs JSON.`,
        );
      }
    }

    let value = data;
    if (plan.result) {
      try {
        value = await plan.result(data, call);
      } catch (error) {
        throw failed("failed in its result projection:", error);
      }
    }
    if (outputSchema) {
      const parsed = outputSchema.safeParse(value);
      if (parsed.ok === false) {
        throw failed(`answered what its output schema refuses: ${parsed.errors.join(", ")}`);
      }
      value = parsed.value;
    }

    if (value === undefined) return null;
    const serialised = JSON.stringify(value);
    if (serialised !== undefined && serialised.length > MAX_RESULT_BODY) {
      return `${serialised.slice(0, MAX_RESULT_BODY)}… [cut at ${MAX_RESULT_BODY} of ${serialised.length} characters]`;
    }
    return value;
  }

  /**
   * Runs an app's binder. Its failure is the server's, not the model's, so the
   * model is told only that; the app gets the error in its log.
   *
   * With `refusals`, a `ToolError` (an `McpToolError` is one) is the app
   * refusing what the model sent, and is passed on for the model to read. Only
   * a model-facing param's resolver gets that: it is translating the model's
   * own words, so "there is no such page" is something the model can fix. A
   * plain binder reads nothing of the model's, and its throw stays the
   * server's.
   */
  private async bind<T>(
    plan: Plan,
    what: string,
    fn: () => T | Promise<T>,
    options: { refusals?: boolean } = {},
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (options.refusals && error instanceof ToolError) throw error;
      console.error(`[gemi/mcp] Binding ${what} of "${plan.descriptor.name}" failed:`, error);
      throw new McpToolError(`"${plan.descriptor.name}" failed on the server.`, 500);
    }
  }
}

/**
 * A caller is one of the two shapes, and a remote one carries a principal a
 * resolver built. Checked because the registry is reachable from app code and
 * JavaScript: a remote caller without a user would be dispatched as nobody.
 */
function assertCaller(caller: McpCaller) {
  if (caller?.kind === "local" && caller.req) return;
  if (
    caller?.kind === "remote" &&
    caller.req &&
    caller.principal?.user &&
    typeof caller.principal.id === "string" &&
    Array.isArray(caller.principal.scopes)
  ) {
    return;
  }
  throw new Error(
    'McpRegistry: a caller is { kind: "local", req } or { kind: "remote", req, principal }, with the principal a caller resolver verified.',
  );
}

function passes(descriptor: McpToolDescriptor, filter?: McpToolFilter): boolean {
  if (filter?.names && !filter.names.includes(descriptor.name)) return false;
  if (filter?.tags && !descriptor.tags.some((tag) => filter.tags!.includes(tag))) return false;
  return true;
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

function remoteFileOptions(options: McpRemoteFileOptions | undefined) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("McpRegistry: files.maxBytes must be a positive whole number of bytes.");
  }
  const fetch =
    options?.fetchUrls === true
      ? {}
      : typeof options?.fetchUrls === "object" && options.fetchUrls !== null
        ? options.fetchUrls
        : null;
  return { maxBytes, fetch };
}

/** 1 to 255 characters, no control characters and no path separators. */
function isSafeFileName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  for (const char of name) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || char === "/" || char === "\\") return false;
  }
  return true;
}

/** `type/subtype`, with parameters, as RFC 6838 restricts the names. */
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(\s*;.{0,200})?$/;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function padding(data: string): number {
  return data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
}

/** A binder is a function or `"input"`; anything else would leave the value to nobody. */
function assertBinder(where: string, at: string, binder: unknown) {
  if (binder !== "input" && typeof binder !== "function") {
    throw new Error(`${where}: ${at} must be a function or "input".`);
  }
}

/**
 * By brand, as a declaration is, rather than `instanceof`: an app that ends up
 * with two copies of gemi would otherwise see its params as broken binders.
 */
function isModelParam(value: unknown): value is McpModelParam<any, any> {
  return value instanceof Object && (value as McpModelParam).__internal_brand === "McpModelParam";
}

/** A `this.param(...)`, checked for a router written in JavaScript or behind a cast. */
function assertModelParam(where: string, at: string, param: McpModelParam<any, any>) {
  if (param.as !== undefined && (typeof param.as !== "string" || param.as === "")) {
    throw new Error(`${where}: ${at}.as must be a non-empty string.`);
  }
  const schema = param.input;
  if (typeof schema?.safeParse !== "function" || typeof schema.toJSONSchema !== "function") {
    throw new Error(`${where}: ${at}.input must be a schema, built with s.`);
  }
  if (typeof param.bind !== "function") {
    throw new Error(`${where}: ${at}.bind must be a function.`);
  }
}

const ANNOTATION_KEYS = new Set<string>([
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
]);

/** What the verb says, before the meta's overrides. */
function verbAnnotations(method: McpMethod): McpToolAnnotations {
  switch (method) {
    case "GET":
      return { readOnlyHint: true };
    case "DELETE":
      return { destructiveHint: true };
    case "PUT":
      return { idempotentHint: true };
    default:
      return {};
  }
}

/**
 * The verb's hints with the meta's laid over them, hint by hint. Checked for a
 * router written in JavaScript or behind a cast: an unknown key is a typo that
 * would silently leave the verb's default standing, and a non-boolean is not a
 * hint a client can read.
 */
function annotationsFor(
  where: string,
  method: McpMethod,
  overrides: McpToolAnnotations | undefined,
): Readonly<McpToolAnnotations> {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null)) {
    throw new Error(`${where}: annotations must be an object of hints.`);
  }
  const merged: McpToolAnnotations = verbAnnotations(method);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!ANNOTATION_KEYS.has(key)) {
      throw new Error(
        `${where}: "${key}" is not a tool annotation. Use readOnlyHint, destructiveHint, idempotentHint or openWorldHint.`,
      );
    }
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`${where}: annotations.${key} must be true or false.`);
    }
    (merged as Record<string, boolean>)[key] = value;
  }
  if (merged.readOnlyHint === true && (merged.destructiveHint || merged.idempotentHint)) {
    throw new Error(
      `${where} is read-only${overrides?.readOnlyHint ? "" : ` (a ${method})`} and also ${merged.destructiveHint ? "destructive" : "idempotent"}, which only a tool that is not read-only can be. Set readOnlyHint: false if it changes something.`,
    );
  }
  return Object.freeze(merged);
}

/**
 * One schema out of two: the app's `input`, and the strings for `"input"`
 * params and files.
 *
 * Built by hand, like `questionSchema` in `ai/Agent.ts`, rather than by
 * widening `s` with a merge: `Schema.ts` is deliberately the strict
 * structured-output subset and owns no operation on a finished schema. Both
 * halves are real `s` schemas, each parses the whole value and drops the keys
 * that are not its own — which is also where a bound param the model sent
 * anyway disappears, since neither half declares it.
 */
function combineSchemas(
  input: AnySchema | undefined,
  base: JSONSchema | undefined,
  extras: AnySchema,
  /**
   * Required fields whose schemas are not `s`'s — a remote caller's files —
   * each parsing its own value. `s.object` refuses a schema it did not build.
   */
  handBuilt: Record<string, AnySchema> = {},
): Schema<Record<string, unknown>> {
  const extra = extras.toJSONSchema();
  const handBuiltJson = Object.fromEntries(
    Object.entries(handBuilt).map(([key, schema]) => [key, schema.toJSONSchema()]),
  );
  const json: JSONSchema = {
    ...(base ?? {}),
    type: "object",
    properties: { ...(base?.properties ?? {}), ...extra.properties, ...handBuiltJson },
    required: [...(base?.required ?? []), ...(extra.required ?? []), ...Object.keys(handBuilt)],
    additionalProperties: false,
  };

  const safeParse = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false as const, errors: ["expected an object"] };
    }
    const errors: string[] = [];
    let out: Record<string, unknown> = {};
    if (input) {
      const own = input.safeParse(value);
      if (own.ok === false) errors.push(...own.errors);
      else out = { ...own.value };
    }
    const more = extras.safeParse(value);
    if (more.ok === false) errors.push(...more.errors);
    else out = { ...out, ...more.value };
    for (const [key, schema] of Object.entries(handBuilt)) {
      const field = (value as Record<string, unknown>)[key];
      if (field === undefined) {
        errors.push(`"${key}" is required`);
        continue;
      }
      const own = schema.safeParse(field);
      if (own.ok === false) errors.push(...own.errors.map((error) => `${key}: ${error}`));
      else out[key] = own.value;
    }
    return errors.length > 0 ? { ok: false as const, errors } : { ok: true as const, value: out };
  };

  return {
    toJSONSchema: () => json,
    safeParse,
    parse(value: unknown) {
      const result = safeParse(value);
      if (result.ok === false) throw new Error(result.errors.join(", "));
      return result.value;
    },
  } as unknown as Schema<Record<string, unknown>>;
}

function withoutKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/**
 * A model-supplied param, as one encoded path segment. `.` and `..` are
 * refused rather than encoded: they encode to themselves, and URL parsing
 * would walk them out of the route.
 */
function encodeSegment(tool: string, param: PathParam, value: string): string {
  const parts = param.modifier === "*" || param.modifier === "+" ? value.split("/") : [value];
  if (parts.some((part) => part === "." || part === "..")) {
    throw new McpToolError(`"${value}" is not a valid value for "${param.name}" of "${tool}".`);
  }
  return parts.map(encodeURIComponent).join("/");
}

/**
 * A JSON field as a multipart form field. A form has only strings, so the
 * route reads `"12"` where a JSON body would have carried `12` — what a
 * browser form sends the same route. An array becomes the key repeated, which
 * `HttpRequest` reads back as an array.
 */
function appendField(form: FormData, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendField(form, key, item);
    return;
  }
  form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
}

/** A GET's input, as the query string `HttpRequest.search` reads. */
function toQuery(json: Record<string, unknown>): string {
  const search = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) add(key, item);
      return;
    }
    search.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  };
  for (const [key, value] of Object.entries(json)) add(key, value);
  return search.toString();
}

async function readResponse(name: string, response: Response): Promise<unknown> {
  if (response.status >= 200 && response.status < 300) {
    const type = response.headers.get("Content-Type");
    if (type && !READABLE.test(type)) {
      const size = (await response.arrayBuffer()).byteLength;
      return `"${name}" answered with ${size} bytes of ${type}, which is not shown.`;
    }
    const text = await response.text();
    if (text === "") return null;
    if (text.length > MAX_RESULT_BODY) {
      return `${text.slice(0, MAX_RESULT_BODY)}… [cut at ${MAX_RESULT_BODY} of ${text.length} characters]`;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const text = await response.text();
  if (response.status >= 400 && response.status < 500) {
    const shown = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
    throw new McpToolError(
      `"${name}" was refused with ${response.status}${shown ? `: ${shown}` : "."}`,
      response.status,
    );
  }
  if (response.status < 500) {
    // A redirect, or a 1xx: nothing the model can follow, and nothing the
    // dispatcher logged.
    console.error(
      `[gemi/mcp] "${name}" answered ${response.status}${response.headers.get("Location") ? ` to ${response.headers.get("Location")}` : ""}, which a tool call cannot follow.`,
    );
  }
  throw new McpToolError(`"${name}" failed on the server.`, response.status);
}
