import type { RemoveGroupPrefix } from "../client/types";
import type {
  AgentController,
  AgentMiddlewareConfig,
  AgentRoute,
  AgentRouteRPC,
  VoiceMiddlewareConfig,
  VoiceRoute,
  VoiceRouteRPC,
} from "../ai/AgentController";
import { isConstructor } from "../internal/isConstructor";
import { Controller, ResourceController, type ControllerMethods } from "./Controller";
import { HttpRequest } from "./HttpRequest";
import { isHttpResponse, type ResponseData, type ResponseError } from "./HttpResponse";
import { type MiddlewareInput, toMiddlewareList } from "./middlewareList";
import type { MiddlewareReturnType } from "./Router";
import {
  createStreamResponse,
  createUnsatisfiableResponse,
  type StreamOutput,
} from "./createStreamResponse";
import { bodyLimitExceeded, bodyLimitOf, PayloadTooLargeError } from "./bodyLimit";
import { RangeNotSatisfiableError } from "./errors";
import { parseRangeHeader } from "./range";
import { RequestContext } from "./requestContext";
import { withheldFromUpstream } from "./requestDomain";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A route as the client's RPC map records it. `Error` is the route's typed
 * error bodies (`ResponseError`), carried on a parameter no call passes so
 * that the existing `ApiRouterHandler<I, infer O, P>` patterns still match:
 * it defaults to `never`, which any route's `Error` accepts.
 */
export type ApiRouterHandler<Input, Output, Params, Error = never> = (
  req: HttpRequest<Input, Params>,
  __error?: [Error],
) => Output;

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

/**
 * A controller route, as `this.get(Controller, "method")` types it: the
 * controller and the method's name, and nothing yet of what the method takes
 * or answers. `CreateRPC` reads those off the method when a route's value is
 * asked for, one route at a time (#774).
 *
 * Mounting a route therefore never resolves its handler. That is what lets a
 * route answer something typed by an agent whose tools are other routes of the
 * same api — a chat's history typed by the agent's messages, beside a typed
 * `toAgentTools` — without the route table referencing itself: inferring a
 * router's `routes` needs the controllers and the methods' names, and
 * `fromApiRoute` checking a url needs the table's keys and that one route's
 * value, never the history's.
 *
 * At runtime it is a plain `RouteHandler`.
 */
export interface ControllerRouteHandler<M extends HttpMethod, C, N>
  extends RouteHandler<M, any, any, any> {
  /** Types only, never set: what `RouteValue` reads the method off. */
  readonly __controllerRoute: { controller: C; method: N };
}

/**
 * What a controller route's method takes and answers, as the client's RPC map
 * records it. Only ever evaluated as one property of `CreateRPC`, which is
 * what keeps it out of the route table's own type.
 */
type ControllerRouteValue<C, N> = C extends new () => infer I
  ? N extends keyof I
    ? I[N] extends (req: HttpRequest<infer Input, infer Params>) => infer Output
      ? ApiRouterHandler<Input, ResponseData<Output>, Params, ResponseError<Output>>
      : never
    : never
  : never;

/**
 * Whether a controller route's method can be dispatched at all, which decides
 * whether the route has a key, as it always has. Checked against a
 * `(req) => any`, which never reads the method's return type: an answer typed
 * by an agent whose tools are this api's routes is not needed to list the
 * api's keys.
 */
type IsControllerRoutable<C, N> = C extends new () => infer I
  ? N extends keyof I
    ? I[N] extends (req: HttpRequest<any, any>) => any
      ? true
      : false
    : false
  : false;

function isController(
  candidate: CallbackHandler<any, any, any> | (new () => Controller),
): candidate is new () => Controller {
  return isConstructor(candidate);
}

/**
 * The controller method a route runs, as `createFlatApiRoutes` records it on
 * each flat entry. Nothing in dispatch reads it; it is there so code that
 * starts from a path can find the handler mounted at it.
 */
export type RouteSource = {
  controller: new () => Controller;
  methodName: string;
};

/**
 * Calls a route's handler with the request, the way a handler written inline
 * gets it (#1110).
 *
 * An inline `(req: HttpRequest) => ...` in a routes or controllers file is
 * rewritten at build time to `(req = new HttpRequest()) => ...`, so it is
 * called with no argument and builds its own. A handler passed by reference
 * (`this.get(showUser)`, imported or declared elsewhere) is not rewritten, so
 * it has to be handed the request.
 *
 * Only a handler that declares a parameter without a default is handed one:
 * `fn.length` counts exactly those. A rewritten handler has length 0 and keeps
 * its default, which matters when the default is a request subclass (`req =
 * new CreateUserRequest()`, with its validation schema) that a plain
 * `HttpRequest` would replace.
 */
function callWithRequest<T>(fn: (req: HttpRequest<any, any>) => T, req?: HttpRequest<any, any>) {
  if (fn.length === 0) {
    return (fn as () => T)();
  }
  return fn(req ?? new HttpRequest());
}

export class RouteHandler<M extends HttpMethod, Input, Output, Params> {
  __internal_brand = "RouteHandler";
  middlewares: string[] = [];

  constructor(
    public method: M,
    private handler: CallbackHandler<Input, Output, Params> | (new () => Controller),
    private methodName?: any,
  ) {
    this.handler = handler;
    this.methodName = methodName;
    this.method = method;
  }

  // A getter rather than making `handler` public: its type mentions none of
  // `Input`/`Output`/`Params`, so the public shape `RouteHandlerParser` infers
  // the RPC types from is the same as before.
  //
  // A callback route has no source. It has no controller, and `{ handler }`
  // would make every reader narrow a second shape that only names an
  // anonymous function.
  //
  // `isController` alone is not enough: it is true for any function with a
  // prototype, so `this.get(function () {...})` passes it with no method name.
  get source(): RouteSource | undefined {
    if (!isController(this.handler) || typeof this.methodName !== "string") {
      return undefined;
    }
    return { controller: this.handler, methodName: this.methodName };
  }

  __internal_use() {
    return {
      run: this.run.bind(this),
      middlewares: this.middlewares,
    };
  }

  run(req?: HttpRequest<Input, Params>): any {
    if (this.source) {
      const controller = new this.source.controller();
      return callWithRequest(controller[this.methodName].bind(controller), req);
    }

    return callWithRequest(this.handler as CallbackHandler<Input, Output, Params>, req);
  }

  middleware(middlewareList: MiddlewareInput) {
    this.middlewares = toMiddlewareList(middlewareList);
    return this;
  }
}

/**
 * The runtime behind `this.proxy(url, headers)`: forwards the request, minus
 * the headers withheld for this app alone, to `url`.
 *
 * It runs behind the same middleware chain as any other route — the global
 * list, the enclosing routers' `middlewares`, then its own `.middleware()` —
 * so `this.proxy(url).middleware(["auth"])` is refused before anything is
 * forwarded (#7). Without any, a proxy route is as public as an unguarded
 * `this.get(...)`, and the client's headers, cookies included, reach `url`.
 */
export class ProxyHandler {
  __internal_brand = "ProxyHandler";
  middlewares: string[] = [];

  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {}

  middleware(middlewareList: MiddlewareInput) {
    this.middlewares = toMiddlewareList(middlewareList);
    return this;
  }

  async run() {
    const req = new HttpRequest();
    const forwarded = req.headers.toJSON();
    for (const header of withheldFromUpstream(req.rawRequest)) {
      delete forwarded[header];
    }
    try {
      return await fetch(this.url, {
        method: req.rawRequest.method,
        headers: {
          ...forwarded,
          ...this.headers,
        },
        body: req.rawRequest.body,
      });
    } catch (err) {
      // A `body-limit` that stopped the forwarded stream surfaces from
      // `fetch` as a network error; answer it as the 413 it is.
      if (bodyLimitExceeded(req.rawRequest)) {
        throw new PayloadTooLargeError(bodyLimitOf(req.rawRequest)!);
      }
      throw err;
    }
  }
}

export class FileHandler {
  constructor(...args: ConstructorParameters<typeof RouteHandler>) {
    return new RouteHandler(...args) as any;
  }

  /**
   * Declared for two reasons: so `this.file(...).middleware([...])` typechecks,
   * and so `FileHandler` is not structurally `{}`. As `{}` it accepted every
   * non-nullish value, which through the `ApiRoutes` union meant a route could
   * be assigned literally anything — `"/x": 42` typechecked.
   *
   * It stays out of the RPC types regardless: `RouteHandlersParser` maps over
   * `keyof T` and only emits members extending `RouteHandler`, and a method
   * does not.
   */
  declare middleware: (middlewareList: string[]) => FileHandler;

  /**
   * Types only, never set: what `CreateFileRPC` finds a file route by, so
   * `fetchBlob`/`fetchText` can take its path. It does not make the route a
   * `RouteHandler`, so `CreateRPC` still leaves it out.
   */
  declare readonly __fileRoute: "file";
}

/**
 * A GET route that serves bytes and understands `Range`.
 *
 * Reads the request's `Range` once, parks it on the request context so
 * `FileStorage.read()` can push it down to the storage backend, and turns
 * whatever the handler returned into a 200, 206 or 416.
 */
export class StreamRouteHandler extends RouteHandler<"GET", any, any, any> {
  __internal_brand = "StreamHandler";

  async run(_req?: HttpRequest<any, any>) {
    const ctx = RequestContext.getStore();
    const rawRequest = ctx?.req?.rawRequest;
    const range = parseRangeHeader(rawRequest?.headers.get("Range"));

    if (ctx) {
      ctx.rangeRequest = range;
    }

    try {
      const output = await super.run(_req as any);
      // An error branch's `HttpResponse.error(502, ...)` and friends: answered
      // by the api dispatcher, with the context's headers and cookies and the
      // `no-store` an error status gets, as on any api route (#714).
      if (isHttpResponse(output)) {
        return output;
      }
      return await createStreamResponse(output, {
        range,
        method: rawRequest?.method,
      });
    } catch (err) {
      // The driver reached the backend and found the window unreachable. It
      // carries the object's real size, which the 416 has to report.
      if (err instanceof RangeNotSatisfiableError) {
        return createUnsatisfiableResponse(err.total);
      }
      throw err;
    } finally {
      // A `FileStorage.read()` later in this request must not inherit it.
      if (ctx) {
        ctx.rangeRequest = null;
      }
    }
  }
}

/**
 * Not a `RouteHandler` at the type level, exactly like `FileHandler`, so a
 * stream route stays out of the generated RPC client types — a typed JSON
 * client has no way to consume a byte stream. `CreateFileRPC` lists it
 * instead, for `fetchBlob`/`fetchText`. At runtime it is a
 * `StreamRouteHandler`.
 */
export class StreamHandler {
  constructor(...args: ConstructorParameters<typeof StreamRouteHandler>) {
    return new StreamRouteHandler(...args) as any;
  }

  /**
   * Declared so `this.stream(...).middleware([...])` typechecks. The runtime
   * object is a `StreamRouteHandler`, which really does have this. Adding it
   * keeps the route out of the RPC types: `RouteHandlersParser` maps over
   * `keyof T` and only emits members that extend `RouteHandler`, and a method
   * does not.
   */
  declare middleware: (middlewareList: string[]) => StreamHandler;

  /** Types only, never set: see `FileHandler.__fileRoute`. */
  declare readonly __fileRoute: "stream";
}

/**
 * A verb map: several methods on one path.
 *
 * `get` also takes `this.stream(...)` and `this.file(...)`, so a path can
 * serve its bytes and accept writes — `{ get: this.stream(...), delete:
 * this.delete(...) }` (#707). Neither is a `RouteHandler` at the type level,
 * so `RouteHandlersParser` drops that `GET` from the RPC types and keeps the
 * other verbs, the same way a stream or file route on its own path is left
 * out. `createFlatApiRoutes` gives a stream `get` its `HEAD` as well.
 */
export type RouteHandlers = Partial<{
  post: RouteHandler<"POST", any, any, any>;
  get: RouteHandler<"GET", any, any, any> | StreamHandler | FileHandler;
  delete: RouteHandler<"DELETE", any, any, any>;
  put: RouteHandler<"PUT", any, any, any>;
  patch: RouteHandler<"PATCH", any, any, any>;
}>;

export type ApiRoutes = Record<
  string,
  | RouteHandler<any, any, any, any>
  | FileHandler
  | StreamHandler
  | ProxyHandler
  | RouteHandlers
  | typeof ApiRouter
  | ResourceRoutes<any>
  | AgentRoute<any>
  | VoiceRoute<any>
>;

export type ResourceRoutes<T extends new () => ResourceController> = {
  first: {
    get: ControllerRouteHandler<"GET", T, TestControllerMethod<T, "list">>;
    post: ControllerRouteHandler<"POST", T, TestControllerMethod<T, "store">>;
  };
  second: {
    get: ControllerRouteHandler<"GET", T, TestControllerMethod<T, "show">>;
    put: ControllerRouteHandler<"PUT", T, TestControllerMethod<T, "update">>;
    delete: ControllerRouteHandler<"DELETE", T, TestControllerMethod<T, "delete">>;
  };
};

export type ResourceMethod = "list" | "store" | "show" | "update" | "delete";

export type ResourceMiddlewareConfig = Partial<Record<ResourceMethod, MiddlewareInput>>;

// The value stored in `routes` for a resource. It carries the plain
// `ResourceRoutes<T>` shape (so RouteParser keeps matching it exactly as
// before) plus a fluent `.middleware()` for per-action middleware.
export type ResourceRoute<T extends new () => ResourceController> = ResourceRoutes<T> & {
  middleware(config: ResourceMiddlewareConfig): ResourceRoute<T>;
};

export class ResourceRouteHandlers<T extends new () => ResourceController> {
  __internal_brand = "ResourceRoutes";

  first: ResourceRoutes<T>["first"];
  second: ResourceRoutes<T>["second"];

  constructor(Controller: T) {
    this.first = {
      get: new RouteHandler("GET", Controller, "list") as any,
      post: new RouteHandler("POST", Controller, "store") as any,
    };
    this.second = {
      get: new RouteHandler("GET", Controller, "show") as any,
      put: new RouteHandler("PUT", Controller, "update") as any,
      delete: new RouteHandler("DELETE", Controller, "delete") as any,
    };
  }

  middleware(config: ResourceMiddlewareConfig) {
    if (config.list) this.first.get.middleware(config.list);
    if (config.store) this.first.post.middleware(config.store);
    if (config.show) this.second.get.middleware(config.show);
    if (config.update) this.second.put.middleware(config.update);
    if (config.delete) this.second.delete.middleware(config.delete);
    return this;
  }
}

export class ApiRouter {
  static __brand = "ApiRouter";
  public routes: ApiRoutes = {};
  public middlewares: string[] = [];
  public middleware(_req: HttpRequest<any, any>): MiddlewareReturnType {}

  public get<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"GET", Input, Output, Params>;
  public get<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ControllerRouteHandler<"GET", T, K>;
  public get<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("GET", handler, methodName);
  }

  public post<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"POST", Input, Output, Params>;
  public post<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ControllerRouteHandler<"POST", T, K>;
  public post<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("POST", handler, methodName);
  }

  public put<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"PUT", Input, Output, Params>;
  public put<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ControllerRouteHandler<"PUT", T, K>;
  public put<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("PUT", handler, methodName);
  }

  public patch<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"PATCH", Input, Output, Params>;
  public patch<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ControllerRouteHandler<"PATCH", T, K>;
  public patch<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("PATCH", handler, methodName);
  }

  public delete<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"DELETE", Input, Output, Params>;
  public delete<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ControllerRouteHandler<"DELETE", T, K>;
  public delete<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("DELETE", handler, methodName);
  }

  public resource<T extends new () => ResourceController>(Controller: T): ResourceRoute<T> {
    return new ResourceRouteHandlers(Controller) as unknown as ResourceRoute<T>;
  }

  /**
   * Mounts an agent controller under one path, the way `resource()` mounts a
   * resource controller: one call, four routes, all of them this controller's.
   *
   * ```ts
   * "/chat": this.agent(ChatController).middleware({ stream: "auth" }),
   * ```
   *
   *   POST /chat        → stream   every client turn
   *   POST /chat/attach → attach   reattach to a run in progress
   *   POST /chat/stop   → stop     explicit cancel
   *   POST /chat/files  → upload   attachments
   *
   * One mounted path is what gives the client one key to name — `useChat("/chat")`
   * — and the sub-routes deliberately do not appear in `CreateRPC` as keys of
   * their own: they are transport for the hook, not endpoints an app calls.
   *
   * The enclosing router's `middlewares` guard all four, exactly as they guard
   * a sibling `this.post(...)` or `this.resource(...)`, and `.middleware()`
   * adds to them per method. That parity is the whole point: a developer who
   * writes `middlewares = ["auth"]` on the router has guarded the model
   * endpoint, and does not have to know that an agent is flattened as a nested
   * router to have got it right. The four names exist so each route can *also*
   * be guarded on its own — `upload` and `stream` are not equally cheap, and
   * `attach` is a read.
   *
   * ONE CAVEAT ON GUARDING THEM DIFFERENTLY, since the example above does
   * exactly that: an agent's attachment scope is derived per route from the
   * request, and by default from `ctx.user`. Guarding `stream` and leaving
   * `upload` open means the two routes compute different scopes for the same
   * user, and every attachment id minted by an upload is then unresolvable in
   * the run that follows — as a not-found, indistinguishable from an id the
   * model made up. See `AgentController.attachmentScope`.
   *
   * `Controller` is checked to be an `AgentController` class when the route is
   * mounted, at boot, and not by the type of the parameter (#774). Checking it
   * at compile time resolves the controller's agent, and so the agent's
   * tools, while the route table is still being inferred: an agent whose tools
   * are routes of this same api, or whose controller is typed by it
   * (`AgentController<ReturnType<typeof makeAgent>>`), then made the table
   * reference itself. A route mounted with anything else has no tools in the
   * client's types (`AgentRouteRPC`), and throws here.
   */
  public agent<T extends object>(Controller: T): AgentRoute<T> {
    if ((Controller as { kind?: unknown }).kind !== "agent-controller") {
      throw new TypeError(
        `this.agent() takes an AgentController class, and got ${describeController(Controller)}.`,
      );
    }
    return createAgentRouteHandlers(Controller as any) as unknown as AgentRoute<T>;
  }

  /**
   * Mounts voice calls in front of an agent controller (#921), the way
   * `agent()` mounts its chat. The controller sets `voice` (a `VoiceConfig`).
   *
   * ```ts
   * "/chat/voice": this.voice(ChatController).middleware({ start: "auth" }),
   * ```
   *
   *   POST   /chat/voice             → voiceStart   create the call
   *   PATCH  /chat/voice/:sessionId  → voiceUpdate  the session's body
   *   DELETE /chat/voice/:sessionId  → voiceEnd     hang up
   *
   * All three run the controller's `authorizeRequest` as `route: "stream"`
   * with the session's thread and body (every delegated turn is a `stream`
   * turn on that thread, so the same check applies), and
   * the enclosing router's `middlewares` guard them as they guard `agent()`'s.
   * One key for the client: `useVoiceSession("/chat/voice")` from
   * `gemi/ai/voice`.
   *
   * @experimental Not yet verified against a live Azure or OpenAI call.
   */
  public voice<T extends object>(Controller: T): VoiceRoute<T> {
    if ((Controller as { kind?: unknown }).kind !== "agent-controller") {
      throw new TypeError(
        `this.voice() takes an AgentController class, and got ${describeController(Controller)}.`,
      );
    }
    return createVoiceRouteHandlers(Controller as any) as unknown as VoiceRoute<T>;
  }

  public file<Input, Output, Params>(handler: CallbackHandler<Input, Output, Params>): FileHandler;
  public file<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): FileHandler;
  public file<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new FileHandler("GET", handler, methodName);
  }

  /**
   * A GET route that serves bytes and answers `Range` requests, so a `<video>`
   * can seek. Return a `FileStorage.read()` result to have the byte window
   * pushed down to the storage backend, or a `Blob`/`Bun.file()` to serve a
   * local file directly.
   *
   * ```ts
   * "/assets/:src*": this.stream(async (req) => FileStorage.read(req.params.src)),
   * ```
   */
  public stream<Input, Output extends StreamOutput, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): StreamHandler;
  public stream<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): StreamHandler;
  public stream<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new StreamHandler("GET", handler, methodName);
  }

  public proxy(url: string, headers: Record<string, string> = {}) {
    return new ProxyHandler(url, headers);
  }
}

function describeController(candidate: unknown) {
  if (typeof candidate === "function" && candidate.name) return candidate.name;
  return typeof candidate;
}

/**
 * The runtime behind `this.agent()`.
 *
 * It is an `ApiRouter` subclass rather than a shape of its own, and that is the
 * whole trick: an agent mounts four paths under one key, which is exactly what
 * a nested router already does, so `createFlatApiRoutes` needs no new branch
 * and the sub-paths get prefixing, per-method middleware and OPTIONS for free.
 * A parallel mechanism would have to reimplement all of it, and would be the
 * second place to fix when route flattening changes.
 *
 * The enclosing routers' `middlewares` reach its four routes the way they reach
 * any nested router's: `createFlatApiRoutes` puts them in front of its own
 * (#1022). Until then it copied its owner's list itself, because flattening
 * dropped them.
 *
 * The four handlers are built once and shared with `routes`, because
 * `.middleware()` is called on the class — at `routes = {...}` time — while
 * `routes` is read off an instance the dispatcher constructs later. Rebuilding
 * them per instance would quietly drop every per-method middleware.
 */
function createAgentRouteHandlers<T extends new () => AgentController<any, any>>(Controller: T) {
  const handlers = {
    stream: new RouteHandler("POST", Controller as any, "stream"),
    attach: new RouteHandler("POST", Controller as any, "attach"),
    stop: new RouteHandler("POST", Controller as any, "stop"),
    upload: new RouteHandler("POST", Controller as any, "upload"),
  };

  return class AgentRouteHandlers extends ApiRouter {
    static __internal_brand = "AgentRoute" as const;
    static controller = Controller;
    static handlers = handlers;

    routes: ApiRoutes = {
      "/": handlers.stream,
      "/attach": handlers.attach,
      "/stop": handlers.stop,
      "/files": handlers.upload,
    };

    static middleware(config: AgentMiddlewareConfig) {
      if (config.stream) handlers.stream.middleware(config.stream);
      if (config.attach) handlers.attach.middleware(config.attach);
      if (config.stop) handlers.stop.middleware(config.stop);
      if (config.upload) handlers.upload.middleware(config.upload);
      return this;
    }
  };
}

/**
 * The runtime behind `this.voice()`: a nested router, for the reasons
 * `createAgentRouteHandlers` gives, guarded by the enclosing router's
 * `middlewares` the same way.
 */
function createVoiceRouteHandlers<T extends new () => AgentController<any, any>>(Controller: T) {
  const handlers = {
    start: new RouteHandler("POST", Controller as any, "voiceStart"),
    update: new RouteHandler("PATCH", Controller as any, "voiceUpdate"),
    end: new RouteHandler("DELETE", Controller as any, "voiceEnd"),
  };

  return class VoiceRouteHandlers extends ApiRouter {
    static __internal_brand = "VoiceRoute" as const;
    static controller = Controller;
    static handlers = handlers;

    routes: ApiRoutes = {
      "/": handlers.start,
      "/:sessionId": { patch: handlers.update, delete: handlers.end },
    };

    static middleware(config: VoiceMiddlewareConfig) {
      if (config.start) handlers.start.middleware(config.start);
      if (config.update) handlers.update.middleware(config.update);
      if (config.end) handlers.end.middleware(config.end);
      return this;
    }
  };
}

type TestControllerMethod<T extends new () => Controller, K extends string> =
  K extends ControllerMethods<T> ? K : never;

/**
 * One route of the RPC map: its key, and the route its value is read off — not
 * the value. `CreateRPC` reads it per key (`RouteValue`), so listing the keys,
 * or reading one route's value, never evaluates another route's handler (#774).
 */
type RouteEntry<K, R> = { key: K; route: R };

/**
 * A route's value in the RPC map. Evaluated only as the template of
 * `CreateRPC`, which a mapped type resolves one property at a time.
 */
type RouteValue<R> =
  R extends AgentRoute<infer C extends new () => AgentController<any, any>>
    ? AgentRouteRPC<C>
    : R extends VoiceRoute<infer C extends new () => AgentController<any, any>>
      ? VoiceRouteRPC<C>
      : R extends ControllerRouteHandler<any, infer C, infer N>
        ? ControllerRouteValue<C, N>
        : R extends RouteHandler<any, infer Input, infer Output, infer Params>
          ? ApiRouterHandler<Input, ResponseData<Output>, Params, ResponseError<Output>>
          : never;

/** Whether a route has a key: a controller route only when its method can be called. */
type IsRoutable<R> =
  R extends ControllerRouteHandler<any, infer C, infer N> ? IsControllerRoutable<C, N> : true;

type RouteHandlerParser<T, Prefix extends string = ""> =
  T extends RouteHandler<infer Method, any, any, any>
    ? IsRoutable<T> extends true
      ? RouteEntry<`${Method & string}:${Prefix & string}`, T>
      : never
    : never;

type RouteHandlersParser<T, Prefix extends string = ""> = T extends RouteHandlers
  ? {
      [K in keyof T]-?: RouteHandlerParser<T[K], Prefix>;
    }[keyof T]
  : never;

type RouterInstanceParser<
  T extends new () => ApiRouter,
  Prefix extends string,
> = T extends new () => ApiRouter
  ? RouteParser<InstanceType<T>["routes"], `${Prefix & string}`>
  : never;

type ParsePrefixAndKey<
  P extends PropertyKey,
  K extends PropertyKey,
  U extends string = `${P & string}${K & string}`,
> = U extends "//"
  ? "/"
  : U extends `${infer T1}//${infer T2}`
    ? `${RemoveGroupPrefix<T1>}/${RemoveGroupPrefix<T2>}`
    : U extends `${infer T1}/${infer T2}/`
      ? `${RemoveGroupPrefix<T1>}/${RemoveGroupPrefix<T2>}`
      : RemoveGroupPrefix<U>;

type RemoveTrailingId<T> = T extends `${infer Head}/:${infer Tail}`
  ? Tail extends `${string}/:${string}`
    ? `${Head}/:${RemoveTrailingId<Tail>}`
    : Head extends `/:${string}`
      ? "X"
      : `${Head}`
  : T;

type ResourceRoutesParser<
  T extends ResourceRoutes<new () => ResourceController>,
  U extends PropertyKey,
> =
  | RouteHandlersParser<T["first"], RemoveTrailingId<U & string>>
  | RouteHandlersParser<T["second"], `${U & string}`>;

type RouteParser<
  T extends ApiRoutes,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? // Checked before every other branch: `RouteHandlers` is fully optional, so
    // *every* object type extends it, and an agent route reaching that arm
    // would silently produce nothing.
    T[K] extends AgentRoute<any> | VoiceRoute<any>
    ? RouteEntry<ParsePrefixAndKey<Prefix, K>, T[K]>
    : T[K] extends ResourceRoutes<any>
      ? ResourceRoutesParser<T[K], ParsePrefixAndKey<Prefix, K>>
      : T[K] extends RouteHandler<any, any, any, any>
        ? RouteHandlerParser<T[K], ParsePrefixAndKey<Prefix, K>>
        : T[K] extends new () => ApiRouter
          ? RouterInstanceParser<T[K], ParsePrefixAndKey<Prefix, K>>
          : T[K] extends RouteHandlers
            ? RouteHandlersParser<T[K], `${Prefix & string}${K extends "/" ? "" : K & string}`>
            : never
  : never;

/**
 * The client's RPC map of an api router: `"METHOD:/path"` to the route's
 * handler type, and an agent route's mounted path to its `AgentRouteRPC`.
 *
 * Its keys come from the routers' `routes` alone, and each value is read off
 * its own route when it is asked for (#774). `keyof CreateRPC<Api>` and
 * `CreateRPC<Api>["GET:/x"]` therefore never evaluate another route's handler,
 * which is what lets `McpRouter.fromApiRoute` check a url against the api that
 * serves the agent using it.
 */
export type CreateRPC<T extends ApiRouter, Prefix extends PropertyKey = ""> = {
  [E in RouteParser<T["routes"], Prefix> as E["key"]]: RouteValue<E["route"]>;
};

/** A path's `get` in a verb map, when it is a stream or file route. */
type FileVerbEntry<T, Path extends string> = T extends { get?: infer G }
  ? NonNullable<G> extends { readonly __fileRoute: infer Kind }
    ? RouteEntry<Path, Kind>
    : never
  : never;

type FileRouteParser<
  T extends ApiRoutes,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends AgentRoute<any> | VoiceRoute<any>
    ? never
    : T[K] extends ResourceRoutes<any>
      ? never
      : T[K] extends { readonly __fileRoute: infer Kind }
        ? RouteEntry<ParsePrefixAndKey<Prefix, K>, Kind>
        : T[K] extends RouteHandler<any, any, any, any>
          ? never
          : T[K] extends new () => ApiRouter
            ? FileRouteParser<InstanceType<T[K]>["routes"], ParsePrefixAndKey<Prefix, K>>
            : T[K] extends RouteHandlers
              ? FileVerbEntry<T[K], `${Prefix & string}${K extends "/" ? "" : K & string}`>
              : never
  : never;

/**
 * The api's file routes, for `fetchBlob` and `fetchText` from `gemi/client`:
 * the path of every `GET` served by `this.stream(...)` or `this.file(...)` —
 * on its own path or as a verb map's `get`, in nested routers too — to
 * `"stream"` or `"file"`. The paths are spelled as `CreateRPC` spells its
 * `GET:` keys, without the method.
 *
 * Separate from `CreateRPC`, which leaves these routes out: a JSON hook
 * (`useQuery`) can't read their bytes, and the RPC map's keys are what the
 * IDE plugin and `McpRoutes` read.
 */
export type CreateFileRPC<T extends ApiRouter, Prefix extends PropertyKey = ""> = {
  [E in FileRouteParser<T["routes"], Prefix> as E extends { key: infer Key extends PropertyKey }
    ? Key
    : never]: E extends { route: infer Kind } ? Kind : never;
};
