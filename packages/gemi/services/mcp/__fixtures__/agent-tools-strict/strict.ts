/**
 * `toAgentTools` and `ToolShapesOf` under `strict: true`, as an app compiles
 * them (#771). See `toAgentTools.strict.test.ts`, which compiles this file and
 * expects no errors: every `expectTypeOf` and `@ts-expect-error` below is a
 * claim, and an unused `@ts-expect-error` is itself an error.
 *
 * Nothing here reads a route's answer through `DataOf` (#769 is a separate
 * fix): the outputs come from `output` schemas and `result` returns.
 */
import { expectTypeOf } from "vitest";

import { Agent, AgentTool, type ToolShapesOf } from "../../../../ai/Agent";
import type { AgentProvider } from "../../../../ai/AgentProvider";
import { s } from "../../../../ai/Schema";
import type { ToolCallPart } from "../../../../ai/types";
import { ApiRouter, type CreateRPC } from "../../../../http/ApiRouter";
import { Controller } from "../../../../http/Controller";
import { HttpRequest } from "../../../../http/HttpRequest";
import { McpRouter } from "../../../../http/McpRouter";
import type { McpRegistry } from "../../McpRegistry";
import { toAgentTools, type McpToolShapesOf } from "../../toAgentTools";

class DeleteItemsRequest extends HttpRequest<{ ids: string[] }, { pageId: string }> {}
class UploadRequest extends HttpRequest<{ file: File; alt?: string }, { siteId: string }> {}

class CollectionController extends Controller {
  async list() {
    return { collections: [{ id: "c1", name: "Posts", items: 3 }] };
  }
  async deleteItems(_req = new DeleteItemsRequest()) {
    return { ok: true, deleted: 1 };
  }
}

class FileController extends Controller {
  async upload(_req = new UploadRequest()) {
    return { id: "f1" };
  }
}

class Api extends ApiRouter {
  routes = {
    "/pages/:pageId/collections": this.get(CollectionController, "list"),
    "/pages/:pageId/items/delete": this.post(CollectionController, "deleteItems"),
    "/sites/:siteId/files": this.post(FileController, "upload"),
  };
}

type Routes = CreateRPC<Api>;

export class SiteMcpRouter extends McpRouter<Routes> {
  page = this.param({
    as: "page",
    input: s.string().nullable().describe("A page path, or null for this chat's page"),
    bind: (path) => path ?? "home",
  });

  routes = {
    listCollections: this.fromApiRoute("GET", "/pages/:pageId/collections", {
      description: "List the page's collections",
      tags: ["collections"],
      params: { pageId: this.page },
      output: s.array(s.object({ id: s.string(), name: s.string() })),
      result: () => [{ id: "c1", name: "Posts" }],
    }),
    deleteItems: this.fromApiRoute("POST", "/pages/:pageId/items/delete", {
      description: "Delete items",
      tags: ["collections"],
      input: s.object({ ids: s.array(s.string()) }),
      params: { pageId: "input" },
      output: s.object({ ok: s.boolean() }),
      requiresApproval: true,
    }),
    uploadFile: this.fromApiRoute("POST", "/sites/:siteId/files", {
      description: "Upload a file",
      tags: ["files"],
      params: { siteId: () => "s1" },
      files: { file: "input" },
      input: s.object({ alt: s.string().optional() }),
      result: () => ({ uploaded: true as const }),
    }),
  };
}

declare const provider: AgentProvider;
declare const untyped: McpRegistry;
const registry = untyped as McpRegistry<SiteMcpRouter>;

/** A native tool that yields progress, as kyte's `buildPage` does. */
const buildPage = AgentTool.create({
  name: "buildPage",
  description: "Build the page",
  inputSchema: s.object({ prompt: s.string() }),
  outputSchema: s.object({ html: s.string() }),
  execute: async function* (input) {
    yield { step: "drafting" as const };
    return { html: input.prompt };
  },
});

// --- the router's tools keep their names, inputs and outputs -----------------

const agent = Agent.create({
  name: "site",
  provider,
  tools: [buildPage, ...toAgentTools(registry, { filter: { tags: ["collections"] } })],
});
type Shapes = ToolShapesOf<typeof agent.tools>;
type Part = ToolCallPart<Shapes>;

expectTypeOf<keyof Shapes>().toEqualTypeOf<"buildPage" | "listCollections" | "deleteItems">();
expectTypeOf<Shapes["listCollections"]["input"]>().toEqualTypeOf<{ page: string | null }>();
expectTypeOf<Shapes["listCollections"]["output"]>().toEqualTypeOf<{ id: string; name: string }[]>();
expectTypeOf<Shapes["deleteItems"]["input"]>().toEqualTypeOf<{ ids: string[]; pageId: string }>();
expectTypeOf<Shapes["deleteItems"]["output"]>().toEqualTypeOf<{ ok: boolean }>();

export function render(part: Part) {
  if (part.name === "deleteItems") {
    expectTypeOf(part.input.ids).toEqualTypeOf<string[]>();
  }
  if (part.name === "buildPage") {
    // The native tool beside them is still typed, progress included.
    expectTypeOf(part.input.prompt).toEqualTypeOf<string>();
    expectTypeOf(part.progress).toEqualTypeOf<{ step: "drafting" }[] | undefined>();
  }
  // @ts-expect-error uploadFile is tagged "files", which the filter left out
  if (part.name === "uploadFile") return;
}

type BuildPagePart = Extract<Part, { name: "buildPage" }>;
expectTypeOf<BuildPagePart["input"]>().toEqualTypeOf<{ prompt: string }>();

// --- the "input" file field, by name, and the shapes without an agent --------

type Files = McpToolShapesOf<SiteMcpRouter, { names: ["uploadFile"] }>;
expectTypeOf<keyof Files>().toEqualTypeOf<"uploadFile">();
expectTypeOf<Files["uploadFile"]["input"]>().toEqualTypeOf<{ alt?: string; file: string }>();
expectTypeOf<Files["uploadFile"]["output"]>().toEqualTypeOf<{ uploaded: true }>();

// Every tool when nothing filters, or the type argument is explicit.
expectTypeOf<keyof ToolShapesOf<ReturnType<typeof toAgentTools<SiteMcpRouter>>>>().toEqualTypeOf<
  "listCollections" | "deleteItems" | "uploadFile"
>();

// --- namespaces flatten the same way ------------------------------------------

const grouped = Agent.create({
  name: "grouped",
  provider,
  tools: [
    buildPage,
    ...toAgentTools(registry, {
      namespaces: { collections: { description: "The page's collections" } },
    }),
  ],
});
expectTypeOf<keyof ToolShapesOf<typeof grouped.tools>>().toEqualTypeOf<
  "buildPage" | "listCollections" | "deleteItems" | "uploadFile"
>();

// --- an untyped tool degrades only itself -------------------------------------

const mixed = Agent.create({
  name: "mixed",
  provider,
  tools: [buildPage, ...toAgentTools(untyped)],
});
type MixedPart = ToolCallPart<ToolShapesOf<typeof mixed.tools>>;
expectTypeOf<Extract<MixedPart, { name: "buildPage" }>["input"]>().toEqualTypeOf<{
  prompt: string;
}>();

// With no literal name at all, the shapes keep the untyped index, as before.
const onlyUntyped = Agent.create({ name: "only", provider, tools: toAgentTools(untyped) });
expectTypeOf<ToolCallPart<ToolShapesOf<typeof onlyUntyped.tools>>["name"]>().toEqualTypeOf<string>();
