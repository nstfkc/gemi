import type { ToolContext } from "../ai/Agent";
import type { AnySchema, Infer, Schema } from "../ai/Schema";
import type { UrlParser } from "../client/types";
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
 * It is handed the run's request, not a tool context, so the same binder
 * keeps meaning something for a caller that is not an agent run. A binder
 * that needs the user should resolve it from the request's credentials rather
 * than from `req.ctx()`: that store belongs to the request that started the
 * run, and `handleApiRequest` destroys it — `user` included — as soon as a
 * handler returns a `Response`, which a streaming agent route does long before
 * its tools run.
 */
export type McpParamBinder = (
  req: HttpRequest<any, any>,
) => string | number | Promise<string | number>;

/**
 * Picks the attachment a bound file field sends, usually out of `ctx.turn`.
 * The id still resolves through `ctx.attachments`, so a binder can narrow which
 * of the caller's files is sent and can never reach anybody else's. `undefined`
 * means there is no file to send, and the model is told so.
 */
export type McpFileBinder = (ctx: ToolContext) => string | undefined | Promise<string | undefined>;

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
 * A body there is nothing to check against: a handler that never names its
 * request (`async list() {}` infers `unknown`), or one typed `any`. The meta
 * is left unchecked for those rather than refused, because refusing would make
 * every untyped route unexposable for a reason that has nothing to do with the
 * tool.
 */
type IsLoose<B> = IsAny<B> extends true ? true : unknown extends B ? true : false;

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
 */
type InputCheck<I, B> =
  IsLoose<B> extends true
    ? unknown
    : I extends AnySchema
      ? Infer<I> extends JsonBody<B>
        ? [Exclude<keyof Infer<I>, keyof JsonBody<B>>] extends [never]
          ? unknown
          : {
              "input has fields the route's body does not": Exclude<
                keyof Infer<I>,
                keyof JsonBody<B>
              >;
            }
        : Schema<JsonBody<B>>
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

export type McpRouteMeta<H, K, I> = MetaBase & {
  /**
   * The JSON fields the model fills in. Checked against the route's body
   * minus its binary fields. Must be an `s.object(...)`.
   */
  input?: I & NoInfer<InputCheck<I, BodyOf<H>>>;
} & ParamsMeta<K> &
  FilesMeta<BodyOf<H>>;

/** The runtime shape of a meta, generics erased. */
export type McpRouteMetaRuntime = {
  description: string;
  input?: AnySchema;
  tags?: readonly string[];
  requiresApproval?: boolean;
  params?: Record<string, McpParamBinder | "input">;
  files?: Record<string, McpFileBinder | "input">;
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

  fromApiRoute<
    M extends McpMethod,
    K extends keyof RoutesOf<R>[M] & string,
    I extends AnySchema | undefined = undefined,
  >(method: M, url: K, meta: McpRouteMeta<RoutesOf<R>[M][K], K, I>): McpRouteDeclaration<M, K> {
    return new McpRouteDeclaration(method, url, meta as McpRouteMetaRuntime);
  }
}
