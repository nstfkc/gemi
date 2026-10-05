import { NotFoundError, InsufficientPermissionsError } from "./errors";
import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";

/**
 * How a resource policy refuses. Either way it is one answer for a resource
 * that does not exist and one the caller may not use, so the answer never
 * says which.
 *
 * - `"not_found"` (the default): `NotFoundError`, a 404
 *   `{ error: { kind: "not_found", message: "Not found", status: 404 } }`. A
 *   view route renders the app's `404` view.
 * - `"forbidden"`: `InsufficientPermissionsError`, a 403
 *   `{ error: { kind: "permission", … } }`. A view route renders the app's
 *   `404` view under a 403.
 */
export type ResourcePolicyRefusal = "not_found" | "forbidden";

export type ResourcePolicyOptions<R> = {
  /**
   * The route param `fromRoute` and the middleware read, e.g. `"pageId"`.
   * A middleware entry can name another one: `owns-page:id`.
   */
  param?: string;
  /**
   * Looks the resource up by its id. `null` or `undefined` means there is
   * none, which is refused the same way as a resource `allow` refuses.
   *
   * The id is the client's (a route param, a field of an agent's body), so
   * it is always a string here: a number is passed as its string, and
   * anything else is refused before `load` runs.
   */
  load: (
    id: string,
    req: HttpRequest<any, any>,
  ) => R | null | undefined | Promise<R | null | undefined>;
  /**
   * Whether this request may use the resource. Read the caller off the
   * request: `req.ctx().user` behind `auth`, `Auth.user()` without it, or a
   * cookie of the app's own for a signed-out owner.
   *
   * An error it throws propagates as itself, so a failed query is a 500 and
   * not a refusal.
   */
  allow: (resource: R, req: HttpRequest<any, any>) => boolean | Promise<boolean>;
  /** How a refusal answers. `"not_found"` when absent. */
  refuse?: ResourcePolicyRefusal;
};

/**
 * What `AgentController.authorizeRequest` is told, as far as a resource policy
 * needs it. `AuthorizeRequestParams` is assignable to it.
 */
export type AgentResourceRequest<Body> = {
  route: "stream" | "upload" | "attach" | "stop";
  threadId?: string;
  body?: Body;
};

/** A resource policy bound to an agent's routes. See `forAgent`. */
export type AgentResource<Body> = {
  authorize(req: HttpRequest<any, any>, params: AgentResourceRequest<Body>): Promise<void>;
};

export type AgentResourceOptions<Body> = {
  /**
   * The resource's id in the client's `body`, on `stream` and `upload`.
   * May be async, for a body that names the resource through something else
   * (a page id naming its site).
   */
  body: (body: Body, req: HttpRequest<any, any>) => unknown;
  /**
   * The id of the resource a thread belongs to, or `null` for a thread the
   * app does not know. Without it, a request that names a thread is refused:
   * nothing else ties a thread to the resource.
   */
  thread?: (threadId: string, req: HttpRequest<any, any>) => unknown;
};

/**
 * One rule for who may use a resource, applied the same way by a route's
 * middleware, a handler, and an agent's routes.
 *
 * ```ts
 * export const PagePolicy = defineResourcePolicy({
 *   param: "pageId",
 *   load: (id) => Page.findUnique({ where: { publicId: id } }),
 *   allow: (page, req) => page.ownerId === req.ctx().user?.id,
 * });
 * ```
 *
 * See "Resource policies" in docs/authorization.md.
 */
export class ResourcePolicy<R> {
  readonly param: string | undefined;
  readonly refuse: ResourcePolicyRefusal;

  /**
   * The answers already given in a request, by its `Request` and the id, so
   * the middleware and the handler after it load the resource once.
   */
  private readonly answers = new WeakMap<Request, Map<string, Promise<R>>>();

  constructor(private readonly options: ResourcePolicyOptions<R>) {
    this.param = options.param;
    this.refuse = options.refuse ?? "not_found";
  }

  /** The error this policy refuses with. */
  refusal(): NotFoundError | InsufficientPermissionsError {
    return this.refuse === "forbidden" ? new InsufficientPermissionsError() : new NotFoundError();
  }

  /**
   * The resource with this id, when this request may use it. Otherwise
   * throws the policy's refusal, the same one for a resource that does not
   * exist. Answered once per request and id.
   */
  authorize(req: HttpRequest<any, any>, id: unknown): Promise<R> {
    if (typeof id === "number" && Number.isFinite(id)) {
      id = String(id);
    }
    if (typeof id !== "string" || id === "") {
      return Promise.reject(this.refusal());
    }
    let answers = this.answers.get(req.rawRequest);
    if (!answers) {
      answers = new Map();
      this.answers.set(req.rawRequest, answers);
    }
    let answer = answers.get(id);
    if (!answer) {
      answer = this.decide(req, id);
      answers.set(id, answer);
    }
    return answer;
  }

  /** `authorize` without the throw: whether this request may use it. */
  async allows(req: HttpRequest<any, any>, id: unknown): Promise<boolean> {
    try {
      await this.authorize(req, id);
      return true;
    } catch (err) {
      if (this.isRefusal(err)) return false;
      throw err;
    }
  }

  /**
   * `authorize` for the route's param: `param` unless another is named. The
   * request is the current one when absent, for a handler that is not handed
   * one.
   */
  fromRoute(
    req: HttpRequest<any, any> = new HttpRequest(),
    param: string | undefined = this.param,
  ): Promise<R> {
    if (param === undefined) {
      throw new Error(
        "This resource policy has no `param`. Give `defineResourcePolicy` one, or name it: `fromRoute(req, \"pageId\")`, or `alias:pageId` on the middleware.",
      );
    }
    return this.authorize(req, (req.params as Record<string, unknown> | undefined)?.[param]);
  }

  /**
   * A middleware that refuses the request unless the route's param names a
   * resource the caller may use. Register it under an alias, one per policy:
   *
   * ```ts
   * aliases: { "owns-page": PagePolicy.middleware }
   * ```
   *
   * `owns-page:id` reads the param `id` instead, and `-owns-page` opts a
   * route out of a router's.
   */
  get middleware(): new (req: HttpRequest<any, any>) => Middleware {
    if (!this.middlewareClass) {
      const fromRoute = (req: HttpRequest<any, any>, param?: string) =>
        this.fromRoute(req, param || undefined);
      this.middlewareClass = class ResourcePolicyMiddleware extends Middleware {
        async run(param?: string) {
          await fromRoute(this.req, param);
        }
      };
    }
    return this.middlewareClass;
  }

  private middlewareClass: (new (req: HttpRequest<any, any>) => Middleware) | undefined;

  /**
   * This policy on an agent's routes, for `AgentController.resource`:
   *
   * - `stream` and `upload` authorize the resource the `body` names. When the
   *   request names a thread too, it must be a thread of that resource.
   * - `attach` and `stop` authorize the resource the thread belongs to. A stop
   *   by run id alone names no thread and is left to `runOwner`.
   *
   * A thread `thread` does not know (`null`), or any thread when there is no
   * `thread`, is refused like a resource the caller may not use.
   */
  forAgent<Body>(options: AgentResourceOptions<Body>): AgentResource<Body> {
    return {
      authorize: async (req, { threadId, body }) => {
        let threadResource: unknown;
        if (threadId !== undefined) {
          threadResource = options.thread ? await options.thread(threadId, req) : null;
          if (threadResource === null || threadResource === undefined) {
            throw this.refusal();
          }
        }
        if (body !== undefined) {
          const id = await options.body(body, req);
          await this.authorize(req, id);
          if (threadId !== undefined && String(threadResource) !== String(id)) {
            throw this.refusal();
          }
          return;
        }
        if (threadId !== undefined) {
          await this.authorize(req, threadResource);
        }
      },
    };
  }

  private async decide(req: HttpRequest<any, any>, id: string): Promise<R> {
    const resource = await this.options.load(id, req);
    if (resource === null || resource === undefined || !(await this.options.allow(resource, req))) {
      throw this.refusal();
    }
    return resource;
  }

  private isRefusal(err: unknown) {
    return this.refuse === "forbidden"
      ? err instanceof InsufficientPermissionsError
      : err instanceof NotFoundError;
  }
}

/** See `ResourcePolicy`. */
export function defineResourcePolicy<R>(options: ResourcePolicyOptions<R>): ResourcePolicy<R> {
  return new ResourcePolicy(options);
}
