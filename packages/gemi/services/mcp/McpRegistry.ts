import type { ToolContext } from "../../ai/Agent";
import { s, type AnySchema, type JSONSchema, type Schema } from "../../ai/Schema";
import type { RouteSource } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import type {
  McpFileBinder,
  McpMethod,
  McpParamBinder,
  McpRouteDeclaration,
  McpRouter,
} from "../../http/McpRouter";
import type { ApiRouteDispatcher } from "../router/ApiRouteDispatcher";

/**
 * Who a tool call runs as. Always an argument, never read from ambient state.
 *
 * `local` is an agent running in this server, and `req` is the request that
 * started its run — `ctx.req` at the moment the tool executes, not when the
 * tool was built, which is what lets one set of tools serve every user's run.
 * The call is dispatched with that request's credentials, so it runs as that
 * user, through that route's middleware.
 *
 * `remote` is v2's MCP client with a bearer token. It is typed so the seam
 * exists and every entry point already takes it; each of them refuses it,
 * because a token resolver is what makes it safe and there is none yet.
 * Reading the caller from `RequestContext` instead would have been shorter,
 * and would have left v2 a registry that only works inside a gemi request.
 */
export type McpCaller =
  | { kind: "local"; req: HttpRequest<any, any> }
  | { kind: "remote"; token: string };

/**
 * MCP's tool annotations, from the verb. They drive confirmation prompts in
 * remote clients, which is why they are set now rather than when v2 lands:
 * every app would otherwise have to revisit its MCP file to get them.
 *
 * Only what the verb says is set. POST and PATCH carry nothing, and MCP's
 * defaults for an unannotated tool — not read-only, possibly destructive — are
 * the honest answer for them.
 */
export type McpToolAnnotations = {
  readOnlyHint?: true;
  destructiveHint?: true;
  idempotentHint?: true;
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
   * `"input"` path param and every `"input"` file field. Bound params and
   * bound files are not in it at all.
   */
  readonly inputSchema: Schema<Record<string, unknown>>;
  readonly annotations: McpToolAnnotations;
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
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpToolError";
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

type PathParam = { name: string; modifier: string };

type Plan = {
  descriptor: McpToolDescriptor;
  params: PathParam[];
  paramBinders: Map<string, McpParamBinder>;
  fileFields: { name: string; binder: McpFileBinder | "input" }[];
  jsonKeys: string[];
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
export class McpRegistry {
  static token = "router.mcp";

  private readonly plans = new Map<string, Plan>();

  constructor(
    router: McpRouter<any>,
    private readonly dispatcher: Pick<
      ApiRouteDispatcher,
      "flatRoutes" | "dispatchAs" | "getRouteHandlerAndParams"
    >,
  ) {
    for (const [name, declaration] of Object.entries(router.routes ?? {})) {
      this.plans.set(name, this.plan(name, declaration));
    }
  }

  /**
   * The tools `caller` may see. v1 has only local callers, and every declared
   * tool is visible to every one of them; `filter` is taken now so the shape
   * v2's per-token visibility needs is the shape callers already use.
   */
  list(caller: McpCaller, filter?: McpToolFilter): McpToolDescriptor[] {
    assertLocal(caller);
    return this.descriptors(filter);
  }

  /**
   * The same listing without a caller, for a projection built once before any
   * caller exists — `toAgentTools`. It is not per-caller visibility, and a v2
   * remote listing must go through `list`.
   */
  descriptors(filter?: McpToolFilter): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = [];
    for (const { descriptor } of this.plans.values()) {
      if (filter?.names && !filter.names.includes(descriptor.name)) continue;
      if (filter?.tags && !descriptor.tags.some((tag) => filter.tags.includes(tag))) continue;
      out.push(descriptor);
    }
    return out;
  }

  /**
   * Calls the tool `name` as `caller`, and answers the route's JSON.
   *
   * `ctx` is the tool context of the agent call, and only files need it:
   * `"input"` files resolve through `ctx.attachments`, the handle already
   * scoped to the caller, and bound files are chosen by a binder given `ctx`.
   * Nothing here reads an attachment any other way — the store has no
   * unscoped lookup, and this must not become one.
   *
   * A 4xx throws an `McpToolError` carrying the route's body, so a validation
   * error reaches the model word for word. A 5xx, or a route that throws,
   * throws an `McpToolError` that says only that the server failed. A throw
   * has already been logged by the dispatcher, and a stack trace or a
   * database message is not something to hand a model that may be steered by
   * whoever wrote the document it is reading.
   */
  async execute(
    caller: McpCaller,
    name: string,
    args: unknown,
    ctx?: ToolContext,
  ): Promise<unknown> {
    assertLocal(caller);
    const plan = this.plans.get(name);
    if (!plan) {
      throw new Error(`McpRegistry: there is no tool named "${name}".`);
    }
    const { descriptor } = plan;

    const parsed = descriptor.inputSchema.safeParse(args);
    if (parsed.ok === false) {
      throw new McpToolError(`Invalid arguments for "${name}": ${parsed.errors.join(", ")}`);
    }
    const input = parsed.value;

    const path = await this.fillPath(plan, input, caller.req);

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
      body = await this.formData(plan, input, json, ctx);
    } else if (descriptor.method === "GET") {
      query = toQuery(json);
    } else if (plan.jsonKeys.length > 0) {
      body = json;
    }

    let response: Response;
    try {
      response = await this.dispatcher.dispatchAs(
        caller.req,
        descriptor.method,
        query ? `${path}?${query}` : path,
        body,
      );
    } catch {
      // What a client would get as a 500. A handler's or a middleware's throw
      // has already been logged by the dispatcher on its way out.
      throw new McpToolError(`"${name}" failed on the server.`, 500);
    }
    return await readResponse(name, response);
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
      assertBinder(where, `params.${key}`, binder);
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
    if (fileFields.length > 0 && method === "GET") {
      throw new Error(`${where}: a GET has no body to carry a file.`);
    }

    const extras: Record<string, AnySchema> = {};
    const paramBinders = new Map<string, McpParamBinder>();
    for (const param of params) {
      const binder = declared[param.name];
      if (binder === "input") {
        const field = s.string().describe(`The ":${param.name}" segment of the url.`);
        extras[param.name] =
          param.modifier === "?" || param.modifier === "*" ? field.optional() : field;
      } else {
        paramBinders.set(param.name, binder);
      }
    }
    for (const file of fileFields) {
      if (file.binder === "input") {
        extras[file.name] = s
          .string()
          .describe(
            "The id of an attachment the user uploaded or a tool produced (gemi_att_…), whose file is sent as this field.",
          );
      }
    }
    for (const key of Object.keys(extras)) {
      if (jsonKeys.includes(key)) {
        throw new Error(
          `${where}: "${key}" is both an input field and a param or file, and the model can only send one.`,
        );
      }
    }

    return {
      descriptor: Object.freeze({
        name,
        description: meta.description,
        method,
        url,
        inputSchema: combineSchemas(meta.input, base, s.object(extras)),
        annotations: annotationsFor(method),
        tags: Object.freeze([...(meta.tags ?? [])]),
        requiresApproval: meta.requiresApproval === true,
        ...(entry.source ? { source: entry.source } : {}),
      }),
      params,
      paramBinders,
      fileFields,
      jsonKeys,
    };
  }

  // --- calling -------------------------------------------------------------

  private async fillPath(
    plan: Plan,
    input: Record<string, unknown>,
    req: HttpRequest<any, any>,
  ): Promise<string> {
    let path = plan.descriptor.url;
    for (const param of plan.params) {
      const binder = plan.paramBinders.get(param.name);
      let value: unknown;
      if (binder) {
        value = await this.bind(plan, `the param "${param.name}"`, () => binder(req));
        if (value === undefined || value === null || value === "") {
          console.error(
            `[gemi/mcp] The binder for "${param.name}" of "${plan.descriptor.name}" returned ${JSON.stringify(value)}.`,
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
    input: Record<string, unknown>,
    json: Record<string, unknown>,
    ctx: ToolContext | undefined,
  ): Promise<FormData> {
    const name = plan.descriptor.name;
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
              (field.binder as McpFileBinder)(ctx),
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
   * Runs an app's binder. Its failure is the server's, not the model's, so the
   * model is told only that; the app gets the error in its log.
   */
  private async bind<T>(plan: Plan, what: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      console.error(`[gemi/mcp] Binding ${what} of "${plan.descriptor.name}" failed:`, error);
      throw new McpToolError(`"${plan.descriptor.name}" failed on the server.`, 500);
    }
  }
}

function assertLocal(caller: McpCaller): asserts caller is Extract<McpCaller, { kind: "local" }> {
  if (caller?.kind !== "local") {
    throw new Error(
      "McpRegistry: only local callers are implemented. A remote caller needs a bearer-token resolver, which v1 does not have — and until it does there is no remote surface to call from.",
    );
  }
}

/** A binder is a function or `"input"`; anything else would leave the value to nobody. */
function assertBinder(where: string, at: string, binder: unknown) {
  if (binder !== "input" && typeof binder !== "function") {
    throw new Error(`${where}: ${at} must be a function or "input".`);
  }
}

function annotationsFor(method: McpMethod): McpToolAnnotations {
  switch (method) {
    case "GET":
      return Object.freeze({ readOnlyHint: true as const });
    case "DELETE":
      return Object.freeze({ destructiveHint: true as const });
    case "PUT":
      return Object.freeze({ idempotentHint: true as const });
    default:
      return Object.freeze({});
  }
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
): Schema<Record<string, unknown>> {
  const extra = extras.toJSONSchema();
  const json: JSONSchema = {
    ...(base ?? {}),
    type: "object",
    properties: { ...(base?.properties ?? {}), ...extra.properties },
    required: [...(base?.required ?? []), ...(extra.required ?? [])],
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
  const text = await response.text();
  if (response.status >= 200 && response.status < 300) {
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (response.status >= 400 && response.status < 500) {
    const shown = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
    throw new McpToolError(
      `"${name}" was refused with ${response.status}${shown ? `: ${shown}` : "."}`,
      response.status,
    );
  }
  throw new McpToolError(`"${name}" failed on the server.`, response.status);
}
