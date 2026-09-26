import { describe, expectTypeOf, test } from "vitest";

import type { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool, type ToolContext } from "./Agent";
import { AgentController, type AgentRouteRPC } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
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

class PageBuilderController extends AgentController<typeof pageAgent, PageBody> {
  agent = pageAgent;
}

/** The same controller without a declared body — the shape every existing app
 *  has, and the one that must keep compiling untouched. */
class PlainController extends AgentController<typeof pageAgent> {
  agent = pageAgent;
}

declare module "../client/rpc" {
  interface RPC {
    "/page-builder": AgentRouteRPC<typeof PageBuilderController>;
    "/plain": AgentRouteRPC<typeof PlainController>;
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

  test("carries it onto the route's RPC entry", () => {
    expectTypeOf<AgentRouteRPC<typeof PageBuilderController>["body"]>().toEqualTypeOf<PageBody>();
  });

  test("and a controller that declares none keeps the open record", () => {
    expectTypeOf<AgentRouteRPC<typeof PlainController>["body"]>().toEqualTypeOf<
      Record<string, unknown>
    >();
  });
});

describe("useChat reads it back off the route", () => {
  test("takes the body the controller declared", () => {
    expectTypeOf<UseChatParams<"/page-builder">["body"]>().toEqualTypeOf<PageBody | undefined>();
  });

  test("so a field the controller does not declare is refused", () => {
    // @ts-expect-error `tenantId` is not part of this controller's body.
    const params: UseChatParams<"/page-builder"> = { body: { pageId: "p1", tenantId: "t1" } };
    void params;
  });

  test("and a missing required field is refused too", () => {
    // @ts-expect-error `pageId` is required.
    const params: UseChatParams<"/page-builder"> = { body: { selectedComponent: "hero" } };
    void params;
  });

  test("a route whose controller declares no body still takes anything", () => {
    const params: UseChatParams<"/plain"> = { body: { whatever: 1, nested: { ok: true } } };
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
