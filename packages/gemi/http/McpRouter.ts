import type { ToolContext } from "../ai/Agent";
import type { AnySchema, Infer, Schema } from "../ai/Schema";
import type { UrlParser } from "../client/types";
import type { McpCallContext, McpCredentials } from "../services/mcp/McpRegistry";
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
 */
export type DataOf<H> = H extends ApiRouterHandler<any, infer O, any, any> ? Awaited<O> : unknown;

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

/**
 * Every path param is either bound or `"input"`, and there is no default: a
 * param left for the model by omission is exactly the tenant-isolation bug
 * this field exists to prevent, so omitting one is a compile error.
 */
type ParamsMeta<K> = string extends keyof ParamsOf<K>
  ? { params?: never }
  : [keyof ParamsOf<K>] extends [never]
    ? { params?: never }
    : { params: { [P in keyof ParamsOf<K>]-?: McpParamBinder | "input" } };

/**
 * Required for every binary field, and refused on a route that has none. For
 * a loose body the fields cannot be known, so any are accepted.
 */
type FilesMeta<B> =
  IsLoose<B> extends true
    ? { files?: Record<string, McpFileBinder | "input"> }
    : [BinaryKeys<B>] extends [never]
      ? { files?: never }
      : { files: { [F in BinaryKeys<B>]: McpFileBinder | "input" } };

type MetaBase = {
  /** The only prose the model gets about this tool. */
  description: string;
  /** For `list`'s filter. Nothing in v1 filters, but the descriptor keeps them. */
  tags?: readonly string[];
  /**
   * Asks the user before an in-process agent runs this tool, as
   * `AgentTool.requiresApproval` does. Never set from the verb: a DELETE of a
   * draft and a POST that charges a card are not ordered by their verbs, and
   * a default that guessed would be a default somebody relies on.
   */
  requiresApproval?: boolean;
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
type ResultMeta<H, O> =
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
      result: (data: DataOf<H>, call: McpResultContext) => ResultReturn<O>;
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

export type McpRouteMeta<H, K, I, O = undefined> = MetaBase &
  InputMeta<BodyOf<H>, I> &
  ParamsMeta<K> &
  FilesMeta<BodyOf<H>> &
  ResultMeta<H, O>;

/** The runtime shape of a meta, generics erased. */
export type McpRouteMetaRuntime = {
  description: string;
  input?: AnySchema;
  tags?: readonly string[];
  requiresApproval?: boolean;
  params?: Record<string, McpParamBinder | "input">;
  files?: Record<string, McpFileBinder | "input">;
  result?: McpResultProjection;
  output?: AnySchema;
};

/**
 * One exposed route: what `fromApiRoute` returns and `routes` holds. Plain
 * data; the registry turns it into a tool descriptor once it can see the
 * route table.
 */
export class McpRouteDeclaration<M extends McpMethod = McpMethod, K extends string = string> {
  readonly __internal_brand = "McpRoute";

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
   * The route's middleware still decides what a credential is worth, so this
   * can reach nothing a direct request carrying the same values could not.
   */
  credentials?(call: McpCallContext): McpCredentials | undefined | Promise<McpCredentials | undefined>;

  fromApiRoute<
    M extends McpMethod,
    K extends keyof RoutesOf<R>[M] & string,
    I extends AnySchema | undefined = undefined,
    O extends AnySchema | undefined = undefined,
  >(
    method: M,
    url: K,
    meta: McpRouteMeta<RoutesOf<R>[M][K], K, I, O>,
  ): McpRouteDeclaration<M, K> {
    return new McpRouteDeclaration(method, url, meta as McpRouteMetaRuntime);
  }
}
