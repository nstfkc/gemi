import type { ToolContext } from "../ai/Agent";
import type { AnySchema, Infer, Schema } from "../ai/Schema";
import type { UrlParser } from "../client/types";
import type { Prettify } from "../utils/type";
import type {
  McpCallContext,
  McpCredentials,
  McpScope,
  McpToolAnnotations,
} from "../services/mcp/McpRegistry";
import type { ApiRouterHandler } from "./ApiRouter";
import type { HttpRequest } from "./HttpRequest";

/**
 * The app's API routes, as `fromApiRoute` sees them: the same
 * `"METHOD:/path"` table `CreateRPC` builds for the client.
 *
 * Empty here and augmented from the app's own `app/http/routes/api.ts` by
 * `gemi.d.ts`, beside `RPC`. It is a separate interface from `RPC` rather than
 * a re-use of it because `RPC` also carries the framework's `/auth` routes, and
 * signing a user in or out is not something a model should be offered by
 * autocomplete. An app that wants one of them can still declare the router
 * over its own table.
 */
export interface McpRoutes {}

/** The verbs a tool can dispatch. HEAD and OPTIONS answer no body a model can use. */
export type McpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Fills a path param from the request that started the run. The model has no
 * say in it: the param is absent from the tool's input schema, and anything
 * the model sends under its name is dropped before the url is built.
 *
 * It is handed the run's request first, so the same binder keeps meaning
 * something for a caller that is not an agent run. A binder may read the user
 * as `req.ctx().user`: that is the store of the request that started the run,
 * and it stays open until the run settles — through a streamed response, and
 * after the client has disconnected, since leaving does not stop the run.
 * `user` is whatever that route's middleware set, so the route that starts the
 * run must be behind `auth` for it to be there.
 *
 * The second argument is the whole call (#756): the caller, the tool, the
 * model's parsed arguments, and `ctx`, the run's `ToolContext` — absent when
 * the registry is called without one. A param that names "the resource this
 * run is about" reads it from there rather than from the chat route's url:
 *
 * ```ts
 * params: { siteId: (_req, { ctx }) => ctx?.context.siteId }
 * ```
 *
 * `ctx.body` is the client's, as untrusted as a request body: bind from it
 * only what the route's own middleware checks anyway.
 */
export type McpParamBinder = (
  req: HttpRequest<any, any>,
  call: McpCallContext,
) => string | number | Promise<string | number>;

/**
 * A path param the model names in its own terms, and the app translates (#767).
 *
 * A bound param leaves the model no say, and an `"input"` one makes it send
 * the raw segment — an id it would have to copy around. This is the third
 * mode: the tool's input schema carries a field in the model's vocabulary
 * (`page: "/about"`), and `bind` turns what the model sent into the segment
 * (`:pageId`) before the url is built.
 *
 * Built with `McpRouter.param`, which is what types `bind`'s `value` from
 * `input`. See `McpModelParamOptions`.
 */
export class McpModelParam<V = unknown, As extends string | undefined = string | undefined> {
  readonly __internal_brand = "McpModelParam";

  constructor(
    /**
     * The key in the tool's input schema, or `undefined` for the param's own
     * name. Kept as a literal in the type, which is what names the field in
     * the tool's typed input (`McpToolInput`, #771).
     */
    readonly as: As,
    readonly input: AnySchema,
    readonly bind: McpModelParamResolver<V>,
  ) {}
}

/**
 * Turns what the model sent for a model-facing param into the url segment.
 *
 * `value` is the model's field, parsed by its schema. `req` and `call` are what
 * a binder gets, so a resolver can look the value up within the resource the
 * run is about (`call.ctx`).
 *
 * To refuse, throw an `McpToolError` (or any `ToolError`): its message reaches
 * the model, which can correct the call — `There is no page "/abuot"`. Any
 * other throw, or an empty answer, is the server's failure: logged, and the
 * model reads only that the tool failed.
 */
export type McpModelParamResolver<V> = (
  value: V,
  req: HttpRequest<any, any>,
  call: McpCallContext,
) => string | number | Promise<string | number>;

/** What `McpRouter.param` takes. */
export type McpModelParamOptions<
  S extends AnySchema,
  As extends string | undefined = string | undefined,
> = {
  /**
   * The field's name in the tool's input schema. Defaults to the param's own
   * name. It is never sent to the route, in the body or the query: it only
   * reaches `bind`, and `call.input`.
   */
  as?: As;
  /**
   * The field's schema, as the model sees it. Describe it here — it is the
   * only thing the model reads about the field:
   * `s.string().nullable().describe("A page path, like /about, or null for this chat's page")`.
   */
  input: S;
  /** Maps the model's value to the segment. See `McpModelParamResolver`. */
  bind: McpModelParamResolver<Infer<S>>;
};

/**
 * Picks the attachment a bound file field sends, usually out of `ctx.turn`.
 * The id still resolves through `ctx.attachments`, so a binder can narrow which
 * of the caller's files is sent and can never reach anybody else's. `undefined`
 * means there is no file to send, and the model is told so.
 *
 * The second argument is the whole call, as a param binder gets it.
 */
export type McpFileBinder = (
  ctx: ToolContext,
  call: McpCallContext,
) => string | undefined | Promise<string | undefined>;

// --- reading the route table -------------------------------------------------

/** `Methods[M][K]`, exactly as `useMutation` splits `RPC` — plus `GET`. */
type RoutesOf<R> = {
  [M in McpMethod]: {
    [K in keyof R as K extends `${M}:${infer P}` ? P : never]: R[K];
  };
};

type IsAny<T> = 0 extends 1 & T ? true : false;

type BodyOf<H> = H extends ApiRouterHandler<infer T, any, any> ? T : never;

/**
 * What the route answers on success, as `useQuery` reads it. The registry
 * hands `result` the parsed JSON, so a `Date` in a handler's return arrives as
 * the string it was serialised to.
 *
 * Read off the return type alone. Matching `ApiRouterHandler<any, infer O,
 * any, any>` instead goes through its `__error?: [Error]` parameter, which
 * `strictFunctionTypes` checks contravariantly: `[any]` is not assignable to a
 * route's `[never]`, so under `strict: true` no route matched and every
 * `result` got `unknown` (#769). The RPC entry's return is already
 * `ResponseData`, so an `HttpResponse` in it is unwrapped by the time it gets
 * here. See `McpRouter.strict.test.ts`.
 */
export type DataOf<H> = H extends (...args: any[]) => infer O ? Awaited<O> : unknown;

/**
 * A body there is nothing to check against: a handler that never names its
 * request (`async list() {}` infers `unknown`), or one typed `any`. The meta
 * is left unchecked for those rather than refused, because refusing would make
 * every untyped route unexposable for a reason that has nothing to do with the
 * tool.
 *
 * `unknown extends B` alone is not the test: a conditional type counts
 * `unknown` as assignable to a body whose fields are all optional, so
 * `{ note?: string }` passed as loose and its `input` went unchecked. A body
 * with keys is never loose.
 */
type IsLoose<B> =
  IsAny<B> extends true
    ? true
    : unknown extends B
      ? [keyof B] extends [never]
        ? true
        : false
      : false;

/**
 * The body fields that carry bytes: a `Blob`/`File`, alone, in a union or in an
 * array. Each one must be declared in `files`, because a model cannot put bytes
 * in a JSON argument — it names an attachment instead.
 *
 * `[B[K]] extends [never]` comes first because the default `HttpRequest` body
 * is `Record<string, never>`, and `never` is assignable to `Blob`: without the
 * guard a route that declares no body would demand a `files` entry for every
 * string.
 */
type BinaryKeys<B> =
  IsLoose<B> extends true
    ? never
    : {
        [K in keyof B]-?: IsAny<B[K]> extends true
          ? never
          : [B[K]] extends [never]
            ? never
            : [Extract<B[K], Blob | readonly Blob[]>] extends [never]
              ? never
              : K;
      }[keyof B] &
        string;

/** What the model fills in as JSON: the body minus its binary fields. */
type JsonBody<B> = Omit<B, BinaryKeys<B>>;

// --- checking the meta -------------------------------------------------------

/**
 * `input` is checked twice. Its type must be assignable to the body — a
 * missing required field or a wrong type fails as `not assignable to
 * Schema<…>` — and it must not have keys the body does not: a field renamed in
 * the handler would otherwise leave the schema asking the model for the old
 * name, and the route would quietly never receive it.
 *
 * The extra keys are checked first. Against a body whose fields are all
 * optional, `{ title }` fails `extends` only as a weak-type mismatch, and the
 * `Schema<…>` fallback then let the builder through, so the rename went
 * unreported.
 */
type InputCheck<I, B> =
  IsLoose<B> extends true
    ? unknown
    : I extends AnySchema
      ? [Exclude<keyof Infer<I>, keyof JsonBody<B>>] extends [never]
        ? Infer<I> extends JsonBody<B>
          ? unknown
          : Schema<JsonBody<B>>
        : {
            "input has fields the route's body does not": Exclude<
              keyof Infer<I>,
              keyof JsonBody<B>
            >;
          }
      : unknown;

type ParamsOf<K> = UrlParser<`${K & string}`>;

/** One path param's declaration: bound, the model's raw segment, or the model's in its own terms. */
export type McpParamDeclaration = McpParamBinder | "input" | McpModelParam<any, any>;

/**
 * Every path param is bound, `"input"` or a `this.param(...)`, and there is no
 * default: a param left for the model by omission is exactly the
 * tenant-isolation bug this field exists to prevent, so omitting one is a
 * compile error.
 */
type ParamsMeta<K, P> = string extends keyof ParamsOf<K>
  ? { params?: never }
  : [keyof ParamsOf<K>] extends [never]
    ? { params?: never }
    : { params: P & NoInfer<ParamsCheck<K, P>> };

/**
 * `params` is inferred as `P`, so the tool's input type can tell `"input"` and
 * `this.param(...)` apart from a binder (#771), and checked here: every param
 * of the url declared, and nothing else.
 */
type ParamsCheck<K, P> = { [X in keyof ParamsOf<K>]-?: McpParamDeclaration } & {
  [X in Exclude<keyof P, keyof ParamsOf<K>>]: never;
};

/**
 * Required for every binary field, and refused on a route that has none. For
 * a loose body the fields cannot be known, so any are accepted.
 */
type FilesMeta<B, F> =
  IsLoose<B> extends true
    ? { files?: F }
    : [BinaryKeys<B>] extends [never]
      ? { files?: never }
      : {
          files: F &
            NoInfer<
              { [X in BinaryKeys<B>]: McpFileBinder | "input" } & {
                [X in Exclude<keyof F, BinaryKeys<B>>]: never;
              }
            >;
        };

type MetaBase<T> = {
  /** The only prose the model gets about this tool. */
  description: string;
  /**
   * For `McpRegistry.descriptors`' and `toAgentTools`' filter. Kept as
   * literals in the type, so a typed `toAgentTools` filtered by tag answers
   * only the tools carrying it (#771).
   */
  tags?: T;
  /**
   * Asks the user before an in-process agent runs this tool, as
   * `AgentTool.requiresApproval` does. Never set from the verb: a DELETE of a
   * draft and a POST that charges a card are not ordered by their verbs, and
   * a default that guessed would be a default somebody relies on.
   */
  requiresApproval?: boolean;
  /**
   * A human-readable name for the tool, for a client to show instead of the
   * `routes` key. The model is still given the key.
   */
  title?: string;
  /**
   * Overrides the hints the verb implies (#760). The verb's are a default:
   * GET is read-only, DELETE destructive, PUT idempotent, and POST and PATCH
   * say nothing. A route that does not follow its verb says so here, and each
   * hint given replaces the verb's — `false` included, which is how a default
   * is taken back:
   *
   * ```ts
   * // A POST that cancels: destructive, and safe to repeat.
   * annotations: { destructiveHint: true, idempotentHint: true },
   * // A search that takes a body: read-only.
   * annotations: { readOnlyHint: true },
   * ```
   *
   * Hints are what a remote client uses to decide when to ask the user; they
   * are not enforced, and a wrong one is a wrong prompt, not a guard. A tool
   * that must be confirmed sets `requiresApproval` instead.
   */
  annotations?: McpToolAnnotations;
};

/**
 * `input` is required as soon as the JSON part of the body has a required
 * field. Leaving it optional there would let `I` default to `undefined`, which
 * `InputCheck` has nothing to compare, so a route exposed without a schema
 * would compile, offer the model `{}`, and answer every call with a 400 — and
 * a body-less route that later gains a required field would keep a green
 * build. A body whose fields are all optional, or that has none, may leave it
 * out; so may a loose body, which states no fields to require.
 */
type InputMeta<B, I> =
  IsLoose<B> extends true
    ? Partial<InputProp<B, I>>
    : {} extends JsonBody<B>
      ? Partial<InputProp<B, I>>
      : InputProp<B, I>;

type InputProp<B, I> = {
  /**
   * The JSON fields the model fills in. Checked against the route's body
   * minus its binary fields. Must be an `s.object(...)`.
   */
  input: I & NoInfer<InputCheck<I, B>>;
};

/**
 * What `result` is handed beside the route's answer: the whole call, as the
 * binders and the `credentials` hook get it — the tool, the model's parsed
 * arguments, the caller and the run's `ToolContext`.
 */
export type McpResultContext = McpCallContext;

/**
 * Turns the route's answer into what the model is shown. See `ResultMeta`.
 */
export type McpResultProjection<D = any, P = unknown> = (
  data: D,
  call: McpResultContext,
) => P | Promise<P>;

/**
 * An `output` without a `result` must describe what the route answers.
 * Checked one way — the answer must be assignable to the schema's type — so a
 * schema that names fewer fields than the route answers is fine (parsing
 * drops the rest), and one naming a field the route does not have, or with a
 * different type, is not. A route whose answer type is unknown is not checked.
 */
type OutputCheck<O, P> =
  IsAny<P> extends true
    ? unknown
    : unknown extends P
      ? unknown
      : O extends AnySchema
        ? [P] extends [Infer<O>]
          ? unknown
          : { "output does not describe what the route answers": Infer<O> }
        : unknown;

/** What `result` must return: anything, or what `output` describes when it is set. */
type ResultReturn<O> = O extends AnySchema ? Infer<O> | Promise<Infer<O>> : unknown;

/**
 * Two shapes, told apart by whether `result` is there, because `output`
 * describes a different thing in each: what `result` returns, or what the
 * route answers.
 *
 * `result`'s return is checked against `output` through its contextual type
 * rather than by inferring it and comparing afterwards. A type parameter for
 * it would have to be inferred from a context-sensitive function, and any
 * check that mentioned it beside `output` fixed it to its default first.
 */
type ResultMeta<H, O, RR> =
  | {
      /**
       * Trims or reshapes the route's 2xx JSON before the model sees it.
       * Routes are written for a UI and answer whole records; a model needs a
       * few fields of them, and every other one costs context on every call.
       *
       * ```ts
       * result: (pages) => pages.map(({ path, title }) => ({ path, title })),
       * ```
       *
       * A 4xx is not passed through it: a refusal reaches the model as the
       * route wrote it. A throw is the server's failure, logged, and the model
       * is told only that the tool failed.
       */
      result: (
        data: DataOf<H>,
        call: McpResultContext,
      ) => [O] extends [undefined] ? RR : ResultReturn<O>;
      /**
       * The shape of what `result` returns. The return is parsed with it,
       * which drops every field it does not declare. It is the descriptor's
       * `outputSchema`, and the `AgentTool`'s. A value that does not parse is
       * the server's failure.
       */
      output?: O;
    }
  | {
      result?: never;
      /**
       * The shape of what the route answers. The answer is parsed with it,
       * which drops every field it does not declare, so an `output` alone is
       * a projection too: it may name fewer fields than the route answers,
       * never one it does not have. It is the descriptor's `outputSchema`, and
       * the `AgentTool`'s. An answer that does not parse is the server's
       * failure.
       */
      output?: O & NoInfer<OutputCheck<O, DataOf<H>>>;
    };

export type McpRouteMeta<
  H,
  K,
  I,
  O = undefined,
  P = {},
  F = {},
  T = readonly string[],
  RR = never,
> = MetaBase<T> &
  InputMeta<BodyOf<H>, I> &
  ParamsMeta<K, P> &
  FilesMeta<BodyOf<H>, F> &
  ResultMeta<H, O, RR>;

// --- the tool's types, for the client (#771) ---------------------------------

/**
 * What the model sends a tool, as the registry builds its `inputSchema`: the
 * `input` schema's fields, a string for every `"input"` path param (optional
 * when the url makes it optional) and every `"input"` file field, and the
 * model-facing field of every `this.param(...)`, under its `as` or the param's
 * own name. Bound params and files are not in it.
 */
export type McpToolInput<I, K, P, F> = Prettify<
  ([I] extends [undefined] ? {} : I extends AnySchema ? Infer<I> : {}) & {
    [X in keyof ParamsOf<K> as X extends keyof P
      ? P[X] extends "input"
        ? X
        : never
      : never]: string;
  } & {
    -readonly [X in keyof P as P[X] extends McpModelParam<any, infer As>
      ? As extends undefined
        ? X
        : As
      : never]-?: P[X] extends McpModelParam<infer V, any> ? V : never;
  } & {
    -readonly [X in keyof F as F[X] extends "input" ? X : never]-?: string;
  }
>;

/**
 * What a tool answers: what `output` describes when it is set, else what
 * `result` returns when there is one, else the route's own answer.
 */
export type McpToolOutput<H, O, RR> = [O] extends [undefined]
  ? [RR] extends [never]
    ? DataOf<H>
    : Awaited<RR>
  : O extends AnySchema
    ? Infer<O>
    : unknown;

/** The runtime shape of a meta, generics erased. */
export type McpRouteMetaRuntime = {
  description: string;
  input?: AnySchema;
  tags?: readonly string[];
  requiresApproval?: boolean;
  title?: string;
  annotations?: McpToolAnnotations;
  params?: Record<string, McpParamDeclaration>;
  files?: Record<string, McpFileBinder | "input">;
  result?: McpResultProjection;
  output?: AnySchema;
};

/**
 * One exposed route: what `fromApiRoute` returns and `routes` holds. Plain
 * data; the registry turns it into a tool descriptor once it can see the
 * route table.
 */
export class McpRouteDeclaration<
  M extends McpMethod = McpMethod,
  K extends string = string,
  Input = unknown,
  Output = unknown,
  Tags extends readonly string[] = readonly string[],
> {
  readonly __internal_brand = "McpRoute";
  /**
   * Types only, never set: the tool's input, output and tags, which
   * `toAgentTools` reads off a typed router to type its `AgentTool`s (#771).
   */
  declare readonly __tool?: { input: Input; output: Output; tags: Tags };

  constructor(
    readonly method: M,
    readonly url: K,
    readonly meta: McpRouteMetaRuntime,
  ) {}
}

/**
 * Which of an app's API routes a model may call, declared by reference.
 *
 * ```ts
 * export default class extends McpRouter {
 *   routes = {
 *     "create-product": this.fromApiRoute("POST", "/:orgId/products", {
 *       description: "Create a product for the user's organization",
 *       input: s.object({ name: s.string(), price: s.number() }),
 *       params: { orgId: (req) => orgIdOf(req) },
 *       files: { image: "input" },
 *     }),
 *   };
 * }
 * ```
 *
 * Each key of `routes` is the tool's name, as the model and — in v2 — a remote
 * client see it, so it is a contract: renaming one breaks whoever hardcoded
 * it. It is used verbatim, never derived, and must be a valid tool name
 * (`[A-Za-z0-9_-]`, at most 64).
 *
 * Exposing a route grants a model reachability, not authority: every call is
 * dispatched through the route's own middleware as the user who started the
 * run. See `McpRegistry`.
 *
 * `R` is the route table the urls are checked against. An app leaves it at its
 * default, `McpRoutes`, which `gemi.d.ts` fills from its own api router.
 */
export class McpRouter<R = McpRoutes> {
  static __brand = "McpRouter";

  routes: Record<string, McpRouteDeclaration> = {};

  /**
   * The scopes a remote caller's credential can carry, and the tools each one
   * reaches (#762). A remote caller sees, and can call, only the tools a scope
   * it carries reaches; a local caller — an agent in this server — sees every
   * tool, as before.
   *
   * ```ts
   * scopes = {
   *   "pages:read": { description: "Read your site's pages", tags: ["read"] },
   *   "pages:write": { description: "Edit your site's pages", tags: ["write"] },
   *   "site:publish": { description: "Publish your site", names: ["publish-site"] },
   * };
   * ```
   *
   * Each key is an OAuth scope; `description` is what the consent screen
   * shows. Left undeclared, the router has one scope, `"mcp"`, that reaches
   * every tool. A tag or name no tool has, or a scope that reaches nothing,
   * fails the boot.
   *
   * A scope narrows what a credential can reach; it never widens it. Every
   * call still runs as the credential's user, through the route's own
   * middleware.
   */
  scopes?: Record<string, McpScope>;

  /**
   * The app's own credentials for one tool call, sent beside the access token
   * of the user who started the run. Optional; without it a tool call carries
   * gemi's access token and nothing else.
   *
   * For routes whose middleware reads something gemi does not know about: a
   * cookie naming an anonymous owner, or a header the app signs per run so a
   * route can check what this run may touch.
   *
   * ```ts
   * credentials({ req, ctx }: McpCallContext) {
   *   return {
   *     cookies: { owner: req.cookies.get("owner") },
   *     headers: { "x-run-grant": signGrant(ctx?.runId) },
   *   };
   * }
   * ```
   *
   * Nothing of the initiator's is forwarded unless it is returned here, value
   * by value. `access_token`, `Cookie`, `Host`, `User-Agent`, the body's
   * framing headers and `x-forwarded-*` cannot be set: the identity stays the
   * initiator's, and the call fails on the server, logged, if one is returned.
   * For a remote caller (`call.caller.kind === "remote"`) `Authorization` is
   * refused too: the client's token is for the MCP endpoint, and is never
   * passed on.
   * The route's middleware still decides what a credential is worth, so this
   * can reach nothing a direct request carrying the same values could not.
   */
  credentials?(call: McpCallContext): McpCredentials | undefined | Promise<McpCredentials | undefined>;

  /**
   * A path param the model names in its own terms, for `params` (#767).
   *
   * ```ts
   * params: {
   *   pageId: this.param({
   *     as: "page",
   *     input: s.string().nullable().describe("A page path, like /about, or null for this chat's page"),
   *     bind: (path, _req, { ctx }) => pageIdFor(ctx, path),
   *   }),
   * }
   * ```
   *
   * The tool's input schema has `page`, described as written, and no `pageId`.
   * `bind` gets the model's value, parsed and typed by `input`, and answers the
   * segment; a `McpToolError` it throws reaches the model. The answer is then
   * treated exactly as a model-supplied segment would be: encoded as one
   * segment and dispatched through the route's own middleware, which decides
   * whether the caller may reach it.
   *
   * The result is plain data and can be shared by several tools: declare it as
   * a field above `routes` and use it in each.
   */
  param<S extends AnySchema, const As extends string | undefined = undefined>(
    options: McpModelParamOptions<S, As>,
  ): McpModelParam<Infer<S>, As> {
    return new McpModelParam(options.as, options.input, options.bind);
  }

  fromApiRoute<
    M extends McpMethod,
    K extends keyof RoutesOf<R>[M] & string,
    I extends AnySchema | undefined = undefined,
    O extends AnySchema | undefined = undefined,
    const P extends Record<string, McpParamDeclaration> = {},
    const F extends Record<string, McpFileBinder | "input"> = {},
    const T extends readonly string[] = readonly [],
    RR = never,
  >(
    method: M,
    url: K,
    meta: McpRouteMeta<RoutesOf<R>[M][K], K, I, O, P, F, T, RR>,
  ): McpRouteDeclaration<
    M,
    K,
    McpToolInput<I, K, P, F>,
    McpToolOutput<RoutesOf<R>[M][K], O, RR>,
    T
  > {
    return new McpRouteDeclaration(method, url, meta as McpRouteMetaRuntime);
  }
}
