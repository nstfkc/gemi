import { Auth } from "../facades/Auth";
import { app } from "../foundation/app";
import { ormContext } from "../orm/context";
import { isPolicyDeniedError, isRecordNotFoundError } from "../orm/errors";
import type { BroadcastEvent } from "../services/broadcast/BroadcastEvent";
import {
  buildTopic,
  InvalidChannelError,
  parsePattern,
  USER_CHANNEL,
  userTopic,
  type ChannelParams,
} from "../services/broadcast/channels";
import type { AnyBroadcastEvents } from "../services/broadcast/types";
import { MiddlewareRegistry } from "../services/middleware/MiddlewareRegistry";
import { GEMI_REQUEST_BREAKER_ERROR } from "./Error";
import { HttpRequest } from "./HttpRequest";
import { toMiddlewareList, type MiddlewareInput } from "./middlewareList";
import { type CarriedContext, RequestContext } from "./requestContext";

/**
 * Decides whether the request may join a channel. `params` are the pattern's
 * params, already checked. Only `true` lets it in.
 */
export type ChannelAuthorizer = (
  req: HttpRequest<any, any>,
  params: Record<string, string>,
) => boolean | Promise<boolean>;

/** A class form of `ChannelAuthorizer`, for an authorization worth naming. */
export interface ChannelPolicy {
  authorize(req: HttpRequest<any, any>, params: Record<string, string>): boolean | Promise<boolean>;
}

export type ChannelPolicyClass = new () => ChannelPolicy;

type BroadcastEventClass = abstract new (...args: any[]) => BroadcastEvent<any, any>;

/** `.events(A, B)` → `{ [A's name]: A's payload, [B's name]: B's payload }`. */
export type BroadcastEventMap<C extends readonly BroadcastEventClass[]> = {
  [I in InstanceType<C[number]> as I["__broadcast"]["name"]]: I["__broadcast"]["payload"];
};

/** One entry of a `ChannelRouter`'s `channels`. */
export class ChannelDeclaration<Events extends Record<string, unknown> = AnyBroadcastEvents> {
  /** Type-only: the events this channel carries, for `BroadcastRPC`. */
  declare readonly __events: Events;

  middlewares: string[] = [];

  constructor(
    readonly visibility: "public" | "private",
    readonly authorizer?: ChannelAuthorizer | ChannelPolicyClass,
  ) {}

  /**
   * Middleware to run before the authorization, as on a route: aliases from
   * the middleware config or `alias:params`. A middleware that refuses (an
   * `auth`, a breaker, a policy denial) refuses the subscription.
   */
  middleware(input: MiddlewareInput): this {
    this.middlewares = [...this.middlewares, ...toMiddlewareList(input)];
    return this;
  }

  /**
   * The events this channel carries, for the generated `BroadcastRPC` types:
   * `BroadcastEvent` classes, or a map as a type argument.
   *
   * ```ts
   * "site.:siteId": this.private(canEdit).events(SiteChanged),
   * "status": this.public().events<{ deploy: { version: string } }>(),
   * ```
   *
   * Types only: nothing is checked at runtime.
   */
  events<E extends Record<string, unknown>>(): ChannelDeclaration<E>;
  events<C extends BroadcastEventClass[]>(...classes: C): ChannelDeclaration<BroadcastEventMap<C>>;
  events(..._classes: unknown[]): ChannelDeclaration<any> {
    return this;
  }
}

/** Why a subscription was refused, as the transport reports it. */
export type ChannelRefusal = "unknown_channel" | "invalid_params" | "denied" | "error";

export type ChannelAuthorization =
  | { ok: true; topic: string; pattern: string }
  | { ok: false; code: ChannelRefusal };

export interface ChannelAuthorizeOptions {
  /** What the global middleware resolved for the upgrade request: its user. */
  carried?: CarriedContext | null;
}

/**
 * The channels clients may subscribe to, in `app/http/routes/channels.ts`,
 * and who may join each.
 *
 * ```ts
 * import { ChannelRouter } from "gemi/http";
 *
 * export default class extends ChannelRouter {
 *   channels = {
 *     "site.:siteId": this.private((req, { siteId }) => Website.canEdit(req, siteId)).events(SiteChanged),
 *     "page.:pageId": this.private(PageChannelPolicy).middleware("page-owner"),
 *     "user": this.private(),   // joins user.<id> of the signed-in user
 *     "status": this.public(),
 *   };
 * }
 * ```
 *
 * A client names a pattern and its params; the server builds the topic, so
 * there is no raw-name or wildcard subscribe, and a pattern that is not here
 * is refused. Authorization runs on every subscribe, resubscribes included,
 * in a request context rebuilt from the upgrade request: `Auth.user()`,
 * `Cookie`, policies and the declared middleware behave as in a route.
 *
 * - `this.public()`: anyone, signed in or not.
 * - `this.private()`: any signed-in user.
 * - `this.private(callback | PolicyClass)`: whoever the callback returns
 *   `true` for, guests included (an anonymous owner's cookie, say). A throw
 *   is a refusal.
 * - `"user"` is special: it takes no params and joins `user.<id>` of the
 *   session's user. Guests are refused. Emit to it with `Broadcast.toUser(user)`.
 *
 * Use public ids in channel names, never internal ones. Register the router
 * as `route.channels` in `app/config/route.ts`.
 */
export class ChannelRouter {
  static __brand = "ChannelRouter";

  channels: Record<string, ChannelDeclaration<any>> = {};

  /** Anyone may join, signed in or not. */
  protected public(): ChannelDeclaration {
    return new ChannelDeclaration("public");
  }

  /**
   * Only who `authorize` returns `true` for. Without it, any signed-in user.
   */
  protected private(authorize?: ChannelAuthorizer | ChannelPolicyClass): ChannelDeclaration {
    return new ChannelDeclaration("private", authorize);
  }

  /**
   * Whether `request` may join the channel `pattern` names with `params`,
   * and the topic it joins. Never throws: a refusal says why, and an
   * unexpected error is logged and refused. Needs a booted application when
   * the channel has middleware.
   *
   * The transport calls this for every `sub`; tests use `authorizeChannel`.
   */
  async authorize(
    request: Request,
    pattern: string,
    params: Record<string, unknown> = {},
    options: ChannelAuthorizeOptions = {},
  ): Promise<ChannelAuthorization> {
    const declaration = Object.hasOwn(this.channels, pattern) ? this.channels[pattern] : undefined;
    // Duck-typed rather than `instanceof`: a production build can hold two
    // copies of gemi, and the app's channels file may use the other one.
    if (!isChannelDeclaration(declaration)) {
      return { ok: false, code: "unknown_channel" };
    }

    let topic: string | null = null;
    try {
      if (pattern === USER_CHANNEL) {
        if (Object.keys(params ?? {}).length > 0) return { ok: false, code: "invalid_params" };
      } else {
        topic = buildTopic(pattern, params ?? {});
      }
    } catch (error) {
      if (error instanceof InvalidChannelError) return { ok: false, code: "invalid_params" };
      throw error;
    }
    const stringParams = Object.fromEntries(
      Object.entries(params ?? {}).map(([key, value]) => [key, String(value)]),
    );

    const httpRequest = new HttpRequest(request, stringParams, "api", pattern);
    // From outside any request or ORM scope, as the server's own `fetch` is:
    // the authorization must see the subscriber, never whoever called this.
    return RequestContext.exit(() =>
      ormContext.exit(() =>
        RequestContext.run(
          httpRequest,
          async (): Promise<ChannelAuthorization> => {
            const ctx = RequestContext.getStore();
            try {
              if (declaration.middlewares.length > 0) {
                await app(MiddlewareRegistry).runMiddleware(declaration.middlewares);
              }
              if (pattern === USER_CHANNEL) {
                const user = await signedInUser();
                if (!user) return { ok: false, code: "denied" };
                topic = userTopic(user as { id: unknown });
                if (declaration.visibility === "private" && declaration.authorizer) {
                  if (
                    (await runAuthorizer(declaration.authorizer, httpRequest, stringParams)) !==
                    true
                  ) {
                    return { ok: false, code: "denied" };
                  }
                }
                return { ok: true, topic, pattern };
              }
              if (declaration.visibility === "private") {
                const allowed = declaration.authorizer
                  ? await runAuthorizer(declaration.authorizer, httpRequest, stringParams)
                  : (await signedInUser()) !== null;
                if (allowed !== true) return { ok: false, code: "denied" };
              }
              return { ok: true, topic: topic!, pattern };
            } catch (error) {
              if (isRefusal(error)) return { ok: false, code: "denied" };
              console.error(
                `[gemi] Authorizing the channel "${pattern}" threw, so the subscription was refused.`,
                error,
              );
              return { ok: false, code: "error" };
            } finally {
              ctx.destroy();
            }
          },
          options.carried,
        ),
      ),
    );
  }
}

/** A `ChannelRouter` subclass, as `route.channels` holds it. */
export type ChannelRouterClass = new () => ChannelRouter;

/**
 * The `BroadcastRPC` table of a router: each pattern's params and events.
 * `gemi.d.ts` builds it from `app/http/routes/channels.ts`.
 */
export type CreateBroadcastRPC<R extends ChannelRouter> = {
  [K in keyof R["channels"] & string]: {
    params: K extends typeof USER_CHANNEL ? {} : ChannelParams<K>;
    events: R["channels"][K] extends ChannelDeclaration<infer E> ? E : AnyBroadcastEvents;
  };
};

/**
 * For tests: whether a subscriber may join the channel `pattern` names with
 * `params`. `as` is the subscriber: a user (as if signed in), a `Request`
 * (its cookies and headers are used, as on an upgrade), or nothing (a guest).
 *
 * ```ts
 * expect(await authorizeChannel(Channels, "site.:siteId", { siteId: other.publicId }, { as: alice })).toBe(false);
 * ```
 *
 * Needs a booted application when the channel declares middleware.
 */
export async function authorizeChannel(
  router: ChannelRouter | ChannelRouterClass,
  pattern: string,
  params: Record<string, unknown> = {},
  options: { as?: Request | { rawRequest: Request } | Record<string, any> | null } = {},
): Promise<boolean> {
  const instance = typeof router === "function" ? new router() : router;
  const as = options.as;
  let request: Request;
  let carried: CarriedContext | null = null;
  if (as instanceof Request) {
    request = as;
  } else if (
    as &&
    typeof as === "object" &&
    (as as { rawRequest?: unknown }).rawRequest instanceof Request
  ) {
    request = (as as { rawRequest: Request }).rawRequest;
  } else {
    request = new Request("http://localhost/__gemi/socket");
    carried = as ? { user: as } : null;
  }
  const result = await instance.authorize(request, pattern, params, { carried });
  return result.ok;
}

function isChannelDeclaration(value: unknown): value is ChannelDeclaration<any> {
  const visibility = (value as { visibility?: unknown } | null)?.visibility;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { middlewares?: unknown }).middlewares) &&
    (visibility === "public" || visibility === "private")
  );
}

async function signedInUser(): Promise<unknown | null> {
  try {
    return await Auth.user();
  } catch {
    return null;
  }
}

function runAuthorizer(
  authorizer: ChannelAuthorizer | ChannelPolicyClass,
  req: HttpRequest<any, any>,
  params: Record<string, string>,
): boolean | Promise<boolean> {
  if (isPolicyClass(authorizer)) {
    return new authorizer().authorize(req, params);
  }
  return (authorizer as ChannelAuthorizer)(req, params);
}

function isPolicyClass(value: unknown): value is ChannelPolicyClass {
  return (
    typeof value === "function" &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === "function"
  );
}

/** A middleware or authorizer that refused, rather than one that broke. */
function isRefusal(error: unknown): boolean {
  return (
    (error as { kind?: unknown })?.kind === GEMI_REQUEST_BREAKER_ERROR ||
    isPolicyDeniedError(error) ||
    isRecordNotFoundError(error)
  );
}

/** Checks every pattern of a router: throws on the first one that is malformed. */
export function assertChannelPatterns(router: ChannelRouter): void {
  for (const pattern of Object.keys(router.channels)) {
    parsePattern(pattern);
  }
}
