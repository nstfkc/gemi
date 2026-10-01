import { describe, expectTypeOf, test } from "vitest";

import type { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool, type ToolContext } from "./Agent";
import {
  AgentController,
  type AgentRouteRPC,
  type AuthorizeRequestParams,
} from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import { ApiRouter } from "../http/ApiRouter";
import type { UseChatParams } from "./useChat";

/**
 * **The body an app sends with every turn, typed from the controller down to
 * `useChat`.**
 *
 * The generic is only worth having if it reaches the client: a `body` the
 * controller does not expect should be a compile error at the call site, not an
 * `undefined` three layers into a tool. That hop runs through `RPC`, which an
 * application augments — so this file augments it too, with one route, rather
 * than adding an agent to the template and changing what every scaffolded
 * project ships.
 */

const tool = AgentTool.create({
  name: "editComponent",
  description: "Edit one component of the page",
  inputSchema: s.object({ id: s.string() }),
  outputSchema: s.object({ ok: s.boolean() }),
  execute: async () => ({ ok: true }),
});

const pageAgent = Agent.create({
  name: "page-builder",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [tool],
});

type PageBody = { pageId: string; selectedComponent?: string };

/**
 * The same shape as an `interface`, which is how most apps write a request body.
 * An interface gets no implicit index signature, so a `Record<string, unknown>`
 * constraint refused it with a `TS2344` naming the constraint and not the reason.
 */
interface InterfaceBody {
  pageId: string;
}

class PageBuilderController extends AgentController<typeof pageAgent, PageBody> {
  agent = pageAgent;
}

class InterfaceController extends AgentController<typeof pageAgent, InterfaceBody> {
  agent = pageAgent;
}

/** The same controller without a declared body — the shape every existing app
 *  has, and the one that must keep compiling untouched. */
class PlainController extends AgentController<typeof pageAgent> {
  agent = pageAgent;
}

/**
 * A controller that declares a body AND keeps the one-parameter `instructions`
 * it already had. This is the upgrade path, since `instructions(req)` was the
 * only signature before the second parameter existed — and it is where the
 * inference silently gave up while `Body` lived on that parameter.
 */
class LegacyOverrideController extends AgentController<typeof pageAgent, PageBody> {
  agent = pageAgent;
  instructions(req: HttpRequest<any, any>) {
    void req;
    return "Today is Tuesday.";
  }
}

/**
 * ONE ROUTE KEY PER TEST FILE, AND NOT A PLAUSIBLE ONE.
 *
 * This augmentation is global to the program, not local to this file, so two
 * test files declaring the same key are two declarations of one property —
 * `TS2717`, whose message prints the two types identically because the classes
 * behind them merely share a name, followed by errors inside `expectTypeOf`
 * assertions that read as though the thing under test broke.
 *
 * It costs nothing to avoid and is confusing to diagnose, so the keys name the
 * file rather than the thing. `/page-builder` was the first spelling here and
 * `ai/useChat.test-d.ts` picked it independently, which is exactly how this
 * goes wrong.
 */
declare module "../client/rpc" {
  interface RPC {
    "/controller-body": AgentRouteRPC<typeof PageBuilderController>;
    "/controller-body-plain": AgentRouteRPC<typeof PlainController>;
    "/controller-body-legacy": AgentRouteRPC<typeof LegacyOverrideController>;
    "/controller-body-interface": AgentRouteRPC<typeof InterfaceController>;
  }
}

describe("a controller that declares its body", () => {
  test("types the second argument of instructions()", () => {
    class Typed extends AgentController<typeof pageAgent, PageBody> {
      agent = pageAgent;
      instructions(_req: HttpRequest<any, any>, extra: { body: PageBody }) {
        expectTypeOf(extra.body).toEqualTypeOf<PageBody>();
        expectTypeOf(extra.body.pageId).toEqualTypeOf<string>();
        return extra.body.pageId;
      }
    }
    expectTypeOf<Typed>().toExtend<AgentController<typeof pageAgent, PageBody>>();
  });

  test("mounts on a router, which is the thing every app must do with it", () => {
    // The assertions below read `AgentRouteRPC["body"]` and `UseChatParams`, and
    // both are reachable without ever mounting the controller — so the first
    // version of this fix looked complete while `this.agent(InterfaceController)`
    // was a `TS2345`: `ApiRouter.agent`, `createAgentRouteHandlers` and
    // `AgentRoute` were all still `AgentController<any>`, i.e. `Body =
    // Record<string, unknown>`, which an interface cannot satisfy. Relaxing the
    // class bound had only moved the error to the route definition.
    class Api extends ApiRouter {
      routes = {
        "/typed": this.agent(PageBuilderController),
        "/iface": this.agent(InterfaceController),
        "/plain": this.agent(PlainController),
        "/legacy": this.agent(LegacyOverrideController),
      };
    }
    expectTypeOf<Api["routes"]["/iface"]>().not.toBeNever();
  });

  test("takes a body declared as an interface, not only a type alias", () => {
    // `Record<string, unknown>` refused this outright, and the guard that used to
    // sit in `AgentRouteRPC` would have silently downgraded it to the open record
    // even if the constraint had let it through — which is the failure the
    // phantom key exists to prevent.
    expectTypeOf<
      AgentRouteRPC<typeof InterfaceController>["body"]
    >().toEqualTypeOf<InterfaceBody>();
    expectTypeOf<UseChatParams<"/controller-body-interface">["body"]>().toEqualTypeOf<
      InterfaceBody | undefined
    >();
  });

  test("carries it onto the route's RPC entry", () => {
    expectTypeOf<AgentRouteRPC<typeof PageBuilderController>["body"]>().toEqualTypeOf<PageBody>();
  });

  test("and keeps carrying it when instructions is overridden with one parameter", () => {
    // The upgrade path, and the case that was silently broken: parameter-wise
    // inference stops at the shorter signature, so while `Body` lived only on
    // `instructions`'s second parameter this resolved to the open record and
    // every call-site check disappeared without a word.
    expectTypeOf<
      AgentRouteRPC<typeof LegacyOverrideController>["body"]
    >().toEqualTypeOf<PageBody>();
    expectTypeOf<UseChatParams<"/controller-body-legacy">["body"]>().toEqualTypeOf<
      PageBody | undefined
    >();
  });

  test("so a wrong field is still refused through a one-parameter override", () => {
    const params: UseChatParams<"/controller-body-legacy"> = {
      body: {
        pageId: "p1",
        // @ts-expect-error `tenantId` is not part of this controller's body.
        tenantId: "t1",
      },
    };
    void params;
  });

  test("and a controller that declares none keeps the open record", () => {
    expectTypeOf<AgentRouteRPC<typeof PlainController>["body"]>().toEqualTypeOf<
      Record<string, unknown>
    >();
  });
});

describe("useChat reads it back off the route", () => {
  test("takes the body the controller declared", () => {
    expectTypeOf<UseChatParams<"/controller-body">["body"]>().toEqualTypeOf<PageBody | undefined>();
  });

  test("so a field the controller does not declare is refused", () => {
    // @ts-expect-error `tenantId` is not part of this controller's body.
    const params: UseChatParams<"/controller-body"> = { body: { pageId: "p1", tenantId: "t1" } };
    void params;
  });

  test("and a missing required field is refused too", () => {
    // @ts-expect-error `pageId` is required.
    const params: UseChatParams<"/controller-body"> = { body: { selectedComponent: "hero" } };
    void params;
  });

  test("a route whose controller declares no body still takes anything", () => {
    const params: UseChatParams<"/controller-body-plain"> = {
      body: { whatever: 1, nested: { ok: true } },
    };
    void params;
  });
});

describe("a tool's ctx.body", () => {
  test("is an open record, because a tool is not bound to one controller", () => {
    // A tool is a module-scope singleton any controller may mount, so there is
    // no single `Body` it could be typed as. The controller gets the typed
    // view; a tool validates what it reads, as it would any other input it did
    // not define.
    expectTypeOf<ToolContext["body"]>().toEqualTypeOf<Record<string, unknown>>();
  });
});

/**
 * #603. `attachmentScope` and `authorizeRequest` get the body, typed as the
 * controller's `Body`, and every override written before that keeps compiling.
 */
describe("the body in attachmentScope and authorizeRequest", () => {
  test("attachmentScope's third argument is the controller's Body", () => {
    class Scoped extends AgentController<typeof pageAgent, PageBody> {
      agent = pageAgent;
      protected async attachmentScope(
        req: HttpRequest<any, any>,
        threadId: string | undefined,
        { body }: { body: PageBody },
      ) {
        expectTypeOf(body.pageId).toEqualTypeOf<string>();
        const scope = await super.attachmentScope(req, threadId);
        return scope ?? { key: `page:${body.pageId}` };
      }
    }
    expectTypeOf<Scoped>().toMatchTypeOf<AgentController<typeof pageAgent, PageBody>>();
  });

  test("the pre-#603 attachmentScope overrides still compile", () => {
    class TwoArgs extends AgentController<typeof pageAgent, PageBody> {
      agent = pageAgent;
      protected attachmentScope(_req: HttpRequest<any, any>, threadId?: string) {
        return threadId ? { key: `thread:${threadId}` } : null;
      }
    }
    class NoArgs extends AgentController<typeof pageAgent> {
      agent = pageAgent;
      protected attachmentScope() {
        return { key: "org:acme" };
      }
    }
    expectTypeOf<TwoArgs>().toMatchTypeOf<AgentController<typeof pageAgent, PageBody>>();
    expectTypeOf<NoArgs>().toMatchTypeOf<AgentController<typeof pageAgent>>();
  });

  test("authorizeRequest has the body on stream and upload, and narrows on route", () => {
    class Guarded extends AgentController<typeof pageAgent, PageBody> {
      agent = pageAgent;
      protected authorizeRequest(
        _req: HttpRequest<any, any>,
        params: AuthorizeRequestParams<PageBody>,
      ) {
        if (params.route === "stream" || params.route === "upload") {
          expectTypeOf(params.body).toEqualTypeOf<PageBody>();
        } else {
          // `body?: undefined` here; this package compiles without
          // `strictNullChecks`, so the narrowed route is what can be pinned.
          expectTypeOf(params.route).toEqualTypeOf<"attach" | "stop">();
        }
      }
    }
    expectTypeOf<Guarded>().toMatchTypeOf<AgentController<typeof pageAgent, PageBody>>();
  });

  test("an authorizeRequest override written against the old params still compiles", () => {
    class Old extends AgentController<typeof pageAgent, PageBody> {
      agent = pageAgent;
      protected authorizeRequest(
        _req: HttpRequest<any, any>,
        params: { route: "stream" | "attach" | "stop" | "upload"; threadId?: string },
      ) {
        void params;
      }
    }
    expectTypeOf<Old>().toMatchTypeOf<AgentController<typeof pageAgent, PageBody>>();
  });
});
