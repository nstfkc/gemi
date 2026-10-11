import { describe, expect, test } from "vitest";

import { McpRouter } from "../http/McpRouter";
import { RequestContext } from "../http/requestContext";
import { McpRegistry, McpToolError } from "../services/mcp/McpRegistry";
import { AgentTool } from "./Agent";
import { ToolError } from "./redact";
import { s } from "./Schema";
import { mcpVoiceTools } from "./voiceMcp";

/**
 * The app's MCP tools as voice tools (#921): listed and run in this process
 * as a principal built from the session's user, with the registry's remote
 * rules. Native tools only, so no route dispatcher is needed; a route tool
 * goes through the same `execute` with the same caller.
 */

const ALICE = { id: 1, name: "alice" };

const seen: { tool: string; user: unknown; input: unknown }[] = [];

const userOfStore = () => (RequestContext.getStore() as { user?: unknown } | undefined)?.user;

const listPages = AgentTool.create({
  name: "list_pages",
  description: "List the site's pages.",
  inputSchema: s.object({ siteId: s.string() }),
  execute: async (input) => {
    seen.push({ tool: "list_pages", user: userOfStore(), input });
    return [{ path: "/about" }];
  },
});
const deletePage = AgentTool.create({
  name: "delete_page",
  description: "Delete a page.",
  inputSchema: s.object({ path: s.string() }),
  requiresApproval: true,
  execute: async () => "deleted",
});
const localOnly = AgentTool.create({
  name: "local_only",
  description: "Not for remote callers.",
  inputSchema: s.object({}),
  execute: async () => "local",
});

class SiteMcp extends McpRouter<any> {
  routes = {
    list_pages: this.fromTool(listPages, { remote: { context: () => ({}) as any } }),
    delete_page: this.fromTool(deletePage, { remote: { context: () => ({}) as any } }),
    local_only: this.fromTool(localOnly),
  };
}

const registry = () => new McpRegistry(new SiteMcp(), {} as any);
const info = { sessionId: "s1", signal: new AbortController().signal };

describe("mcpVoiceTools", () => {
  test("lists the tools a remote principal may call, without approval-gated ones, and runs them as the session's user", async () => {
    seen.length = 0;
    const tools = await mcpVoiceTools({ registry: registry() }, { user: ALICE, sessionId: "s1" });
    expect(tools.map((handler) => handler.tool.name)).toEqual(["list_pages"]);
    expect(tools[0]!.tool.description).toBe("List the site's pages.");

    const output = await tools[0]!.run({ siteId: "site_1" }, info);
    expect(output).toEqual([{ path: "/about" }]);
    expect(seen).toEqual([{ tool: "list_pages", user: ALICE, input: { siteId: "site_1" } }]);
  });

  test("authorize runs first and can refuse with a sentence the model reads", async () => {
    seen.length = 0;
    const [tool] = await mcpVoiceTools(
      {
        registry: registry(),
        authorize: ({ input }) => {
          if ((input as { siteId?: string }).siteId !== "site_1") {
            throw new ToolError("Only this session's site.");
          }
        },
      },
      { user: ALICE, sessionId: "s1" },
    );
    await expect(tool!.run({ siteId: "site_2" }, info)).rejects.toThrow("Only this session's site.");
    expect(seen).toEqual([]);
  });

  test("bad arguments are the registry's McpToolError, for the model to fix", async () => {
    const [tool] = await mcpVoiceTools({ registry: registry() }, { user: ALICE, sessionId: "s1" });
    await expect(tool!.run({ siteId: 1 }, info)).rejects.toBeInstanceOf(McpToolError);
  });

  test("a scope set that reaches nothing lists nothing", async () => {
    const tools = await mcpVoiceTools(
      { registry: registry(), scopes: [] },
      { user: ALICE, sessionId: "s1" },
    );
    expect(tools).toEqual([]);
  });

  test("never as nobody", async () => {
    await expect(
      mcpVoiceTools({ registry: registry() }, { user: null, sessionId: "s1" }),
    ).rejects.toThrow(/signed-in user/);
  });
});
