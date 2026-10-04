/**
 * An agent served from the same api its typed MCP tools come from (#774),
 * compiled under `strict: true`, as an app compiles it. See
 * `toAgentTools.strict.test.ts`, which compiles this file and expects no
 * errors.
 *
 * The shape is kyte's: the agent's tools are `toAgentTools` of a typed
 * registry, whose router exposes routes of the same api that mounts the agent
 * (`this.agent(...)`) and serves the chat's history, typed by the agent's own
 * message type. Every edge of that loop is a real one at the type level, but
 * none needs a route's answer that depends on itself: the history route needs
 * the tools, the tools need the `listCollections` route's answer, and nothing
 * needs the history route's answer except the client.
 *
 * Before #774 this was a cycle: checking a `fromApiRoute` url resolved the
 * whole route table, every handler's answer included, and mounting a route or
 * the agent resolved the controller's types.
 */
import { expectTypeOf } from "vitest";

import { Agent, AgentTool, type ToolShapesOf } from "../../../../ai/Agent";
import { AgentController } from "../../../../ai/AgentController";
import type { AgentProvider } from "../../../../ai/AgentProvider";
import { s } from "../../../../ai/Schema";
import type { AgentMessage, ToolCallPart } from "../../../../ai/types";
import { ApiRouter, type CreateRPC } from "../../../../http/ApiRouter";
import { Controller } from "../../../../http/Controller";
import { HttpRequest } from "../../../../http/HttpRequest";
import { McpRouter } from "../../../../http/McpRouter";
import type { McpRegistry } from "../../McpRegistry";
import { toAgentTools } from "../../toAgentTools";

// --- the app's controllers ----------------------------------------------------

class PageRequest extends HttpRequest<{}, { pageId: string }> {}
class DeleteItemsRequest extends HttpRequest<{ ids: string[] }, { pageId: string }> {}

type AssetsBody = { pageId: string };

class AssetController extends Controller {
  async index(_req = new PageRequest()) {
    return {
      collections: [{ id: "c1", name: "Posts", slug: "posts", items: [1, 2] }],
    };
  }

  async deleteItems(_req = new DeleteItemsRequest()) {
    return { ok: true, deleted: 1 };
  }

  // The chat's history, typed by the agent's own message type, read through
  // the agent's controller: the route's answer needs the agent, and the
  // controller's class.
  async chat(_req = new PageRequest()) {
    const messages = await new AssetsAgentController().readThread("t1");
    return { threadId: "t1", messages: (messages ?? []) as AssetsMessage[] };
  }
}

// The agent's controller, typed by the agent it serves, which is made on
// first use because its tools need the registry.
class AssetsAgentController extends AgentController<ReturnType<typeof assetsAgent>, AssetsBody> {
  get agent() {
    return assetsAgent();
  }
}

// --- the app's api: the agent, its history, and the routes its tools call ----

class PagesRouter extends ApiRouter {
  routes = {
    "/:pageId/assets": this.get(AssetController, "index"),
    "/:pageId/assets/items/delete": this.post(AssetController, "deleteItems"),
    "/:pageId/assets/chat": this.get(AssetController, "chat"),
  };
}

class Api extends ApiRouter {
  routes = {
    "/pages": PagesRouter,
    "/assets-agent": this.agent(AssetsAgentController),
    // The history beside the agent, in the router that mounts it.
    "/assets-chat/:pageId": this.get(AssetController, "chat"),
    "/health": this.get(() => ({ ok: true })),
  };
}

// As `gemi.d.ts` declares `McpRoutes` from the app's api: an interface, over
// `AppRPC`, whose `T extends ApiRouter` checks the api's `routes` against
// `ApiRoutes` — every route, the agent's included.
type IsAny<T> = 0 extends 1 & T ? true : false;
type AppRPC<T> = IsAny<T> extends true ? {} : T extends ApiRouter ? CreateRPC<T> : {};
interface Routes extends AppRPC<Api> {}

// --- the app's MCP router: routes of that same api ---------------------------

class SiteMcpRouter extends McpRouter<Routes> {
  routes = {
    listCollections: this.fromApiRoute("GET", "/pages/:pageId/assets", {
      description: "List the site's collections",
      tags: ["collections"],
      params: { pageId: () => "p1" },
      // Reads the route's answer: only this route's, never the history's.
      result: ({ collections }) => collections.map(({ slug, name }) => ({ slug, name })),
    }),
    deleteItems: this.fromApiRoute("POST", "/pages/:pageId/assets/items/delete", {
      description: "Delete items",
      tags: ["collections"],
      input: s.object({ ids: s.array(s.string()) }),
      params: { pageId: "input" },
      requiresApproval: true,
    }),
  };
}

// --- the agent ---------------------------------------------------------------

declare const provider: AgentProvider;
declare const untyped: McpRegistry;

function siteRegistry() {
  return untyped as McpRegistry<SiteMcpRouter>;
}

const readFiles = AgentTool.create({
  name: "readFiles",
  description: "Read files",
  inputSchema: s.object({ paths: s.array(s.string()) }),
  outputSchema: s.object({ text: s.string() }),
  execute: async ({ paths }) => ({ text: paths.join() }),
});

function createAssetsAgent() {
  return Agent.create({
    name: "assets",
    provider,
    tools: [...toAgentTools(siteRegistry(), { filter: { tags: ["collections"] } }), readFiles],
  });
}

let built: ReturnType<typeof createAssetsAgent> | undefined;

function assetsAgent() {
  return (built ??= createAssetsAgent());
}

type AssetsMessage = AgentMessage<ToolShapesOf<ReturnType<typeof assetsAgent>["tools"]>>;

// --- the agent's tools keep their names and types ----------------------------

type Shapes = ToolShapesOf<ReturnType<typeof assetsAgent>["tools"]>;

expectTypeOf<keyof Shapes>().toEqualTypeOf<"listCollections" | "deleteItems" | "readFiles">();
expectTypeOf<Shapes["listCollections"]["output"]>().toEqualTypeOf<
  { slug: string; name: string }[]
>();
expectTypeOf<Shapes["deleteItems"]["input"]>().toEqualTypeOf<{
  ids: string[];
  pageId: string;
}>();
// No `output` and no `result`: the route's own answer.
expectTypeOf<Shapes["deleteItems"]["output"]>().toEqualTypeOf<{
  ok: boolean;
  deleted: number;
}>();
expectTypeOf<Shapes["readFiles"]["input"]>().toEqualTypeOf<{
  paths: string[];
}>();

// --- the client's table stays whole ------------------------------------------

type RPC = CreateRPC<Api>;

expectTypeOf<RPC["/assets-agent"]["__agent"]>().toEqualTypeOf<true>();
expectTypeOf<RPC["/assets-agent"]["tools"]>().toEqualTypeOf<Shapes>();
expectTypeOf<RPC["/assets-agent"]["body"]>().toEqualTypeOf<AssetsBody>();

type History = Awaited<ReturnType<RPC["GET:/pages/:pageId/assets/chat"]>>;
expectTypeOf<History["messages"]>().toEqualTypeOf<AssetsMessage[]>();
expectTypeOf<Awaited<ReturnType<RPC["GET:/assets-chat/:pageId"]>>["messages"]>().toEqualTypeOf<
  AssetsMessage[]
>();
expectTypeOf<
  Awaited<ReturnType<RPC["GET:/pages/:pageId/assets"]>>["collections"][number]["slug"]
>().toEqualTypeOf<string>();
expectTypeOf<Awaited<ReturnType<RPC["GET:/health"]>>>().toEqualTypeOf<{
  ok: boolean;
}>();

export function render(part: ToolCallPart<Shapes>) {
  if (part.name === "deleteItems") {
    expectTypeOf(part.input.ids).toEqualTypeOf<string[]>();
  }
  // @ts-expect-error not one of the agent's tools
  if (part.name === "uploadFile") return;
}

// --- a url the api does not have is still refused ------------------------------

export class WrongMcpRouter extends McpRouter<Routes> {
  routes = {
    // @ts-expect-error no such route
    missing: this.fromApiRoute("GET", "/pages/:pageId/nope", {
      description: "Nothing",
      params: { pageId: "input" },
    }),
    // @ts-expect-error the history is a GET, not a POST
    wrongVerb: this.fromApiRoute("POST", "/pages/:pageId/assets/chat", {
      description: "Nothing",
      params: { pageId: "input" },
    }),
    // @ts-expect-error the agent's own route is transport, not a tool
    agent: this.fromApiRoute("POST", "/assets-agent", {
      description: "Nothing",
    }),
  };
}

// --- a controller that is not an agent's -------------------------------------

class NotAnAgentController extends Controller {
  async index() {
    return { ok: true };
  }
}

// `this.agent()` cannot refuse it by type without resolving every controller's
// agent while the table is inferred, which is the cycle above: it throws when
// mounted instead, and the client's table gives the route nothing to type.
export class WrongApi extends ApiRouter {
  routes = {
    "/not-an-agent": this.agent(NotAnAgentController),
  };
}
expectTypeOf<CreateRPC<WrongApi>["/not-an-agent"]>().toBeNever();
