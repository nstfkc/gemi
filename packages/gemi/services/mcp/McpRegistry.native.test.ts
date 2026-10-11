import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { Agent, AgentTool, ToolNamespace, type AgentStreamEvent } from "../../ai/Agent";
import type { ProviderEvent } from "../../ai/AgentProvider";
import { fakeProvider } from "../../ai/providers/fakeProvider";
import { ToolError } from "../../ai/redact";
import { s } from "../../ai/Schema";
import type { AgentMessage } from "../../ai/types";
import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { createRoot } from "../../client/createRoot";
import { app as resolve } from "../../foundation/app";
import { ApiRouter, type CreateRPC } from "../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { HttpRequest } from "../../http/HttpRequest";
import type { ProgressUpdate } from "../../http/modelOriginated";
import { McpRouter } from "../../http/McpRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ServiceProvider } from "../../support/ServiceProvider";
import { ApiRouteDispatcher } from "../router/ApiRouteDispatcher";
import {
  McpCallRefusedError,
  McpRegistry,
  McpToolError,
  mcpCallOf,
  type McpCallContext,
  type McpCaller,
  type McpRemotePrincipal,
} from "./McpRegistry";
import { toAgentTools } from "./toAgentTools";

/**
 * Native tools in the registry (#759): an `AgentTool` registered with
 * `fromTool`, listed and projected beside the routes, run with the run's own
 * context for an agent in this server, and with one built for the principal
 * for a remote caller that the meta lets in.
 */

const ALICE = { id: 1, name: "alice", orgId: "org_alice" };
const BOB = { id: 2, name: "bob", orgId: "org_bob" };

const LIVE = {
  expiresAt: new Date(Date.now() + 365 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 365 * 86_400_000),
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    return args.token === "v2.tok-alice"
      ? ({ token: args.token, ...LIVE, user: ALICE } as any)
      : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

const userOf = (req: HttpRequest<any, any>) => req.ctx().user?.id ?? null;
const handled: { route: string; user: number | null }[] = [];

let inside: (req: HttpRequest<any, any>) => Promise<unknown> = async () => ({});

class Api extends ApiRouter {
  routes = {
    "/:orgId/pages": this.get(async (_: HttpRequest<{}, { orgId: string }>) => {
      const req = new HttpRequest<{}, { orgId: string }>();
      handled.push({ route: "pages", user: userOf(req) });
      return [{ path: "/about", orgId: req.params.orgId }];
    }).middleware(["auth"]),
    "/agent": this.post(async () => inside(new HttpRequest<any, any>())).middleware(["auth"]),
    "/mcp-stand-in": this.post(async () => inside(new HttpRequest<any, any>())),
  };
}

/** What each native tool saw, per call. */
const seen: { tool: string; call: McpCallContext | undefined; context: unknown; runId: string }[] = [];

/** A composite tool: reports progress, and lists the pages as its own caller. */
const summarize = AgentTool.create({
  name: "summarize",
  description: "Summarize the site",
  inputSchema: s.object({ focus: s.string() }),
  outputSchema: s.object({ pages: s.number(), focus: s.string() }),
  async *execute(input, ctx) {
    const call = mcpCallOf(ctx);
    seen.push({ tool: "summarize", call, context: ctx.context, runId: ctx.runId });
    yield "Reading pages";
    yield { progress: 5, total: 10, message: "Halfway" };
    const registry = resolve(McpRegistry);
    const pages = (await registry.execute(call!.caller, "list-pages", {}, ctx)) as unknown[];
    // An extra field, which the output schema drops for a remote caller.
    return { pages: pages.length, focus: input.focus, secret: "x" } as any;
  },
});

const localOnly = AgentTool.create({
  name: "local-only",
  description: "Only for agents in this server",
  inputSchema: s.object({}),
  async execute(_input, ctx) {
    seen.push({ tool: "local-only", call: mcpCallOf(ctx), context: ctx.context, runId: ctx.runId });
    return { ok: true };
  },
});

const confirm = AgentTool.create({
  name: "confirm",
  description: "Does something that needs a yes",
  inputSchema: s.object({}),
  requiresApproval: true,
  async execute() {
    return "done";
  },
});

let behave: (ctx: any) => Promise<unknown> = async () => "fine";

const misc = AgentTool.create({
  name: "misc",
  description: "Does whatever the test says",
  inputSchema: s.object({}),
  timeoutMs: 50,
  async: { deadlineMs: 1000 },
  async execute(_input, ctx) {
    return await behave(ctx);
  },
});

class Mcp extends McpRouter<CreateRPC<Api>> {
  scopes = {
    "site:read": { description: "Read your site", tags: ["read"] },
    "site:build": { description: "Build your site", tags: ["build"] },
    "site:misc": { description: "Everything else", names: ["confirm", "misc"] },
  };
  routes = {
    "list-pages": this.fromApiRoute("GET", "/:orgId/pages", {
      description: "List the pages",
      params: { orgId: (req) => req.ctx().user.orgId },
      tags: ["read"],
    }),
    "summarize-site": this.fromTool(summarize, {
      tags: ["build"],
      title: "Summarize the site",
      annotations: { readOnlyHint: true },
      remote: {
        context: ({ caller }) => ({ userId: caller.req.ctx().user.id }) as any,
      },
    }),
    "local-only": this.fromTool(localOnly, { tags: ["build"] }),
    confirm: this.fromTool(confirm, {
      description: "Confirm the thing",
      remote: { context: () => ({}) as any },
    }),
    misc: this.fromTool(misc, {
      requiresApproval: true,
      remote: {
        context: () => ({ via: "remote" }) as any,
        progress: (value: any, n) => ({ progress: n * 10, message: String(value) }),
      },
    }),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware } },
    route: {
      api: { rootRouter: Api },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
      mcp: { router: Mcp },
    },
  };
}

const app = new App({ kernel: AppKernel });
const alice = { Cookie: "access_token=v2.tok-alice" };

const toolCall = (toolCallId: string, name: string, args: unknown): ProviderEvent => ({
  type: "tool-call",
  toolCallId,
  name,
  args: JSON.stringify(args),
});

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

/** One agent run inside a request to `/agent`, in which the model calls `name` once. */
async function runTool(name: string, args: unknown, options: { request?: boolean } = {}) {
  const provider = fakeProvider([toolCall("c1", name, args), finish()], [finish()]);
  const agent = Agent.create({
    name: "site",
    provider,
    tools: toAgentTools(resolve(McpRegistry)),
  });
  const events: AgentStreamEvent[] = [];
  let messages: AgentMessage[] = [];
  const go = async () => {
    const run = agent.stream({
      messages: [],
      turn: { text: "go" },
      attachments: null,
      context: { from: "run" } as any,
    });
    for await (const event of run as AsyncIterable<AgentStreamEvent>) events.push(event);
    messages = (await run.result()).messages as AgentMessage[];
    return {};
  };
  if (options.request === false) {
    await app.waitForBoot();
    await go();
  } else {
    inside = go;
    await app.fetch(new Request("http://gemi.dev/api/agent", { method: "POST", headers: alice }));
  }
  const result = messages
    .flatMap((message) => message.content)
    .find((part: any) => part.type === "tool-result" && part.toolCallId === "c1") as any;
  return { result, events, provider };
}

const principal = (overrides: Partial<McpRemotePrincipal> = {}): McpRemotePrincipal => ({
  user: BOB as any,
  via: "api-key",
  id: "key_1",
  scopes: ["site:read", "site:build", "site:misc"],
  ...overrides,
});

/** Runs `fn` inside a request, as the remote transport does, with the principal's user on it. */
async function asRemote<T>(
  fn: (caller: McpCaller, registry: McpRegistry) => Promise<T>,
  p: McpRemotePrincipal = principal(),
): Promise<T> {
  let out: { ok: true; value: T } | { ok: false; error: unknown } = { ok: false, error: null };
  inside = async (req) => {
    req.ctx().setUser(p.user);
    try {
      out = { ok: true, value: await fn({ kind: "remote", req, principal: p }, resolve(McpRegistry)) };
    } catch (error) {
      out = { ok: false, error };
    }
    return {};
  };
  await app.fetch(new Request("http://gemi.dev/api/mcp-stand-in", { method: "POST" }));
  if (out.ok === false) throw out.error;
  return out.value;
}

beforeEach(() => {
  seen.length = 0;
  handled.length = 0;
  behave = async () => "fine";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("descriptors", () => {
  test("a native tool is listed beside the routes, with its own schema and no verb", async () => {
    await app.waitForBoot();
    const registry = resolve(McpRegistry);
    const [route] = registry.descriptors({ names: ["list-pages"] });
    expect(route.kind).toBe("route");
    expect(route.method).toBe("GET");

    const [tool] = registry.descriptors({ names: ["summarize-site"] });
    expect(tool.kind).toBe("tool");
    expect(tool.method).toBeUndefined();
    expect(tool.url).toBeUndefined();
    expect(tool.description).toBe("Summarize the site");
    expect(tool.title).toBe("Summarize the site");
    expect(tool.inputSchema.toJSONSchema()).toEqual(summarize.inputSchema.toJSONSchema!());
    expect(tool.outputSchema).toBe(summarize.outputSchema);
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.tags).toEqual(["build"]);
    expect(tool.requiresApproval).toBe(false);
  });

  test("approval: the tool's own, or added by the meta; the description may be overridden", async () => {
    await app.waitForBoot();
    const registry = resolve(McpRegistry);
    const [confirmTool] = registry.descriptors({ names: ["confirm"] });
    expect(confirmTool.requiresApproval).toBe(true);
    expect(confirmTool.description).toBe("Confirm the thing");
    expect(confirmTool.annotations).toEqual({});
    expect(registry.descriptors({ names: ["misc"] })[0].requiresApproval).toBe(true);
  });

  test("filters and scopes treat both kinds alike", async () => {
    await app.waitForBoot();
    const registry = resolve(McpRegistry);
    expect(registry.descriptors({ tags: ["build"] }).map((tool) => tool.name)).toEqual([
      "summarize-site",
      "local-only",
    ]);
    expect(registry.scopesFor("summarize-site")).toEqual(["site:build"]);
  });
});

describe("the boot", () => {
  const boot = (routes: (router: McpRouter<any>) => Record<string, unknown>) => {
    class Broken extends McpRouter<any> {
      routes = routes(this) as any;
    }
    const dispatcher = resolve(ApiRouteDispatcher);
    return () => new McpRegistry(new Broken(), dispatcher);
  };

  test("refuses what it cannot list or run", async () => {
    await app.waitForBoot();
    const client = AgentTool.ask({ name: "ask", description: "Ask", outputSchema: s.string() });
    expect(boot((r) => ({ ask: r.fromTool(client as any) }))).toThrow(/answered by the client/);

    const perRun = AgentTool.create({
      name: "per-run",
      description: "Per run",
      inputSchema: () => s.object({}),
      async execute() {
        return 1;
      },
    });
    expect(boot((r) => ({ perRun: r.fromTool(perRun) }))).toThrow(/fixed inputSchema/);

    expect(boot((r) => ({ confirm: r.fromTool(confirm, { requiresApproval: false }) }))).toThrow(
      /requires approval/,
    );
    expect(boot((r) => ({ misc: r.fromTool(misc, { remote: {} as any }) }))).toThrow(
      /remote must be/,
    );
    expect(boot((r) => ({ "bad name": r.fromTool(misc) }))).toThrow(/not a valid tool name/);
    expect(boot((r) => ({ misc: r.fromTool(misc, { annotations: { readOnly: true } as any }) }))).toThrow(
      /not a tool annotation/,
    );
    expect(boot(() => ({ misc: { some: "thing" } }))).toThrow(/fromApiRoute\(\.\.\.\) or this\.fromTool/);
  });
});

describe("for an agent in this server", () => {
  test("runs with the run's own context, its yields are tool-progress, and it composes routes as the user", async () => {
    const { result, events } = await runTool("summarize-site", { focus: "pricing" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ pages: 1, focus: "pricing", secret: "x" });
    expect(
      events.filter((event) => event.type === "tool-progress").map((event: any) => event.data),
    ).toEqual(["Reading pages", { progress: 5, total: 10, message: "Halfway" }]);

    expect(seen).toHaveLength(1);
    expect(seen[0].context).toEqual({ from: "run" });
    expect(seen[0].call?.caller.kind).toBe("local");
    expect(seen[0].call?.tool.name).toBe("summarize-site");
    expect(seen[0].call?.input).toEqual({ focus: "pricing" });
    expect(handled).toEqual([{ route: "pages", user: ALICE.id }]);
  });

  test("keeps the tool's approval, timeout and async", async () => {
    await app.waitForBoot();
    const tools = toAgentTools(resolve(McpRegistry));
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.confirm.requiresApproval).toBe(true);
    expect(byName.misc.requiresApproval).toBe(true);
    expect(byName.misc.timeoutMs).toBe(50);
    expect(byName.misc.async).toEqual({ deadlineMs: 1000 });
    expect(byName["summarize-site"].outputSchema).toBe(summarize.outputSchema);
  });

  test("is grouped into a namespace by its tag", async () => {
    await app.waitForBoot();
    const entries = toAgentTools(resolve(McpRegistry), {
      namespaces: { build: { description: "Build the site" } },
    });
    const namespace = entries.find((entry) => entry instanceof ToolNamespace) as ToolNamespace;
    expect(namespace.tools.map((tool) => tool.name)).toEqual(["summarize-site", "local-only"]);
  });

  test("a run with no request still runs it, as the agent would have, without a call", async () => {
    const { result } = await runTool("local-only", {}, { request: false });
    expect(result.status).toBe("ok");
    expect(seen).toEqual([
      expect.objectContaining({ tool: "local-only", call: undefined, context: { from: "run" } }),
    ]);
  });

  test("execute without a tool context is the caller's mistake", async () => {
    await app.waitForBoot();
    const req = new HttpRequest(new Request("http://gemi.dev/api/agent", { headers: alice }));
    await expect(
      resolve(McpRegistry).execute({ kind: "local", req }, "local-only", {}),
    ).rejects.toThrow(/tool context/);
  });
});

describe("for a remote caller", () => {
  test("only the tools whose meta lets it in are listed", async () => {
    const tools = await asRemote(async (caller, registry) => registry.list(caller));
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "confirm",
      "list-pages",
      "misc",
      "summarize-site",
    ]);
  });

  test("a local-only tool is refused as unknown, even when a scope reaches it", async () => {
    await expect(
      asRemote((caller, registry) => registry.execute(caller, "local-only", {})),
    ).rejects.toBeInstanceOf(McpCallRefusedError);
    expect(seen).toEqual([]);
  });

  test("scopes hold for a native tool as for a route", async () => {
    await expect(
      asRemote(
        (caller, registry) => registry.execute(caller, "summarize-site", { focus: "x" }),
        principal({ scopes: ["site:read"] }),
      ),
    ).rejects.toMatchObject({ reason: "unknown-tool" });
  });

  test("runs with the context the meta builds, reports progress, and composes routes as the principal", async () => {
    const progress: ProgressUpdate[] = [];
    const value = await asRemote((caller, registry) =>
      registry.execute(caller, "summarize-site", { focus: "pricing" }, undefined, {
        progress: (update) => progress.push(update),
      }),
    );
    // Parsed by the tool's output schema: the extra field is gone.
    expect(value).toEqual({ pages: 1, focus: "pricing" });
    expect(progress).toEqual([
      { progress: 1, message: "Reading pages" },
      { progress: 5, total: 10, message: "Halfway" },
    ]);
    expect(seen[0].context).toEqual({ userId: BOB.id });
    expect(seen[0].runId).toMatch(/^mcp_/);
    expect(seen[0].call?.caller.kind).toBe("remote");
    expect(handled).toEqual([{ route: "pages", user: BOB.id }]);
  });

  test("a composed route the scopes do not reach is refused, and the model reads why", async () => {
    await expect(
      asRemote(
        (caller, registry) => registry.execute(caller, "summarize-site", { focus: "x" }),
        principal({ scopes: ["site:build"] }),
      ),
    ).rejects.toThrow(/There is no tool named "list-pages"/);
    expect(handled).toEqual([]);
  });

  test("approval is required as for a route", async () => {
    await expect(
      asRemote((caller, registry) => registry.execute(caller, "confirm", {})),
    ).rejects.toMatchObject({ reason: "approval-required" });
    const value = await asRemote((caller, registry) =>
      registry.execute(caller, "confirm", {}, undefined, { approved: true }),
    );
    expect(value).toBe("done");
  });

  test("a ToolError reaches the model; anything else is the server's, logged", async () => {
    const run = () =>
      asRemote((caller, registry) => registry.execute(caller, "misc", {}, undefined, { approved: true }));
    behave = async () => {
      throw new ToolError("That page is locked.");
    };
    const refused = await run().catch((error) => error);
    expect(refused).toBeInstanceOf(McpToolError);
    expect(refused.message).toBe("That page is locked.");

    behave = async () => {
      throw new Error("db password is hunter2");
    };
    const failed = await run().catch((error) => error);
    expect(failed).toBeInstanceOf(McpToolError);
    expect(failed.message).toBe('"misc" failed on the server.');
    expect(console.error).toHaveBeenCalled();
  });

  test("what a remote call has none of throws a sentence the model reads", async () => {
    const run = () =>
      asRemote((caller, registry) => registry.execute(caller, "misc", {}, undefined, { approved: true }));
    behave = (ctx) => ctx.attachments.put(new Blob(["x"]));
    await expect(run()).rejects.toThrow(/remote MCP client, which has no attachment store/);
    behave = (ctx) => ctx.runAgent({} as any);
    await expect(run()).rejects.toThrow(/no agent run/);
    behave = async (ctx) => ctx.jobs.track(Promise.resolve(1));
    await expect(run()).rejects.toThrow(/threadId|conversation/);
    behave = async (ctx) => ({ context: ctx.context, turn: ctx.turn, body: ctx.body, depth: ctx.depth });
    expect(await run()).toEqual({ context: { via: "remote" }, turn: { attachments: [] }, body: {}, depth: 0 });
  });

  test("the tool's timeout and the client's cancel stop waiting for it", async () => {
    behave = (ctx) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve("late"), 5000);
        ctx.signal.addEventListener("abort", () => clearTimeout(timer));
      });
    const timedOut = await asRemote((caller, registry) =>
      registry.execute(caller, "misc", {}, undefined, { approved: true }),
    ).catch((error) => error);
    expect(timedOut).toBeInstanceOf(McpToolError);
    expect(timedOut.message).toMatch(/did not finish within 50 ms/);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const cancelled = await asRemote((caller, registry) =>
      registry.execute(caller, "misc", {}, undefined, { approved: true, signal: controller.signal }),
    ).catch((error) => error);
    expect(cancelled.message).toMatch(/was cancelled/);
  });

  test("the meta's progress mapping shapes each yield", async () => {
    const tool = AgentTool.create({
      name: "steps",
      description: "Steps",
      inputSchema: s.object({}),
      async *execute() {
        yield "a";
        yield "b";
        return 2;
      },
    });
    class Steps extends McpRouter<any> {
      routes = {
        steps: this.fromTool(tool, {
          remote: {
            context: () => ({}) as any,
            progress: (value, n) => (value === "a" ? undefined : { progress: n, message: `step ${value}` }),
          },
        }),
      };
    }
    await app.waitForBoot();
    const registry = new McpRegistry(new Steps(), resolve(ApiRouteDispatcher));
    const progress: ProgressUpdate[] = [];
    const value = await asRemote(
      (caller) =>
        registry.execute(caller, "steps", {}, undefined, { progress: (u) => progress.push(u) }),
      principal({ scopes: ["mcp"] }),
    );
    expect(value).toBe(2);
    expect(progress).toEqual([{ progress: 2, message: "step b" }]);
  });

  test("invalid arguments are the model's to fix", async () => {
    await expect(
      asRemote((caller, registry) => registry.execute(caller, "summarize-site", { focus: 1 })),
    ).rejects.toThrow(/Invalid arguments for "summarize-site"/);
  });
});
