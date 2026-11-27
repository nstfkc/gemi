import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

process.env.SECRET ??= "mcp-endpoint-test-secret";

import { s } from "../ai/Schema";
import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { McpApiKeyResolver } from "../services/mcp/http/callers";
import { ApiRouter } from "./ApiRouter";
import { HttpRequest } from "./HttpRequest";
import { McpEndpoint, McpEndpointError } from "./McpEndpoint";
import { McpRouter } from "./McpRouter";
import { clientIp, RateLimitMiddleware } from "./RateLimitMiddleware";
import { ViewRouter } from "./ViewRouter";

/**
 * `McpEndpoint` (#1401): a public MCP endpoint mounted as a route of a domain
 * group, end to end through `App.fetch`.
 */

type Shop = { slug: string; catalog: boolean; checkout: boolean };

const SHOPS: Record<string, Shop> = {
  acme: { slug: "acme", catalog: true, checkout: true },
  bare: { slug: "bare", catalog: false, checkout: false },
};

const searched: { shop: string; query: string; via: string }[] = [];

function search(shop: Shop, query: string, via: string) {
  searched.push({ shop: shop.slug, query, via });
  return { products: [{ id: "p1", title: `${query} at ${shop.slug}` }] };
}

function shopOf(req: HttpRequest<any, any>): Shop | null {
  return SHOPS[req.domain?.params.shop ?? ""] ?? null;
}

class ShopMcp extends McpEndpoint<Shop> {
  caller = "anonymous" as const;
  server = { name: "shop-ucp", version: "2026-08-25", instructions: "A shop." };

  context(req: HttpRequest<any, any>) {
    // `undefined` for a host with no shop: answered 404 like `null`.
    return shopOf(req) ?? undefined;
  }

  tools = {
    search_catalog: this.tool({
      title: "Search the catalog",
      description: "Searches this shop's catalog.",
      inputSchema: {
        type: "object",
        properties: { catalog: { type: "object", properties: { query: { type: "string" } } } },
        required: ["catalog"],
      },
      annotations: { readOnlyHint: true },
      offered: (shop) => shop.catalog,
      rateLimit: "POST /catalog/search",
      run: (args, { context }) => {
        const catalog = args.catalog as { query?: unknown } | undefined;
        if (typeof catalog?.query !== "string") {
          return McpEndpoint.result({ messages: [{ code: "invalid", content: "query" }] }, { isError: true });
        }
        return search(context, catalog.query, "mcp");
      },
    }),
    whereami: this.tool({
      description: "The host's params.",
      inputSchema: s.object({ echo: s.string() }),
      run: ({ echo }, { req, meta }) => ({ params: req.domain?.params, echo, meta }),
    }),
    cancel_checkout: this.tool({
      description: "Cancels a checkout.",
      inputSchema: { type: "object" },
      offered: (shop) => shop.checkout,
      rateLimit: { limit: 1, window: 60 },
      run: () => {
        throw new McpEndpointError(-32000, "Conflict", { status: 409, data: { code: "already_paid" } });
      },
    }),
    crash: this.tool({
      description: "Fails.",
      inputSchema: { type: "object" },
      run: () => {
        throw new Error("database password is hunter2");
      },
    }),
    stale_twin: this.tool({
      description: "Names a twin that is not there.",
      inputSchema: { type: "object" },
      rateLimit: "POST /nowhere",
      run: () => ({ ran: true }),
    }),
  };
}

// The app's own alias, keyed as folio keys `rate-limit-ip`: address and route.
const ipLimit = RateLimitMiddleware.configure({
  key: (req: HttpRequest<any, any>) => `${clientIp(req)}:${req.routePath ?? "*"}`,
});

class RootApi extends ApiRouter {
  routes = {
    "/me": this.get(async () => ({ ok: true })),
  };
}

class AppMcp extends McpRouter<any> {
  routes = {
    me: this.fromApiRoute("GET", "/me" as never, { description: "Me" }),
  };
}

const keys = new McpApiKeyResolver({ prefix: "tk_mcp_", verify: async () => null });

function makeApp(overrides: { endpoint?: typeof ShopMcp } = {}) {
  class Api extends ApiRouter {
    routes = {
      "/catalog/search": this.post(async () => {
        const req = new HttpRequest<any, any>();
        return search(shopOf(req)!, "rest", "rest");
      }).middleware(["auth-free", "rate-limit-ip:2"]),
      "/mcp": this.mcp(overrides.endpoint ?? ShopMcp),
    };
  }
  class TestKernel extends Kernel {
    config = {
      middleware: {
        aliases: {
          "rate-limit-ip": ipLimit,
          // A middleware that is not a rate limit: never run for a tool call.
          "auth-free": class {
            run() {
              ran.push("auth-free");
              return {};
            }
          },
        },
      },
      route: {
        api: { rootRouter: RootApi },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: class extends ViewRouter {},
        },
        domains: {
          root: "shop.test",
          groups: [{ subdomain: ":shop", exists: async () => true, api: { rootRouter: Api } }],
        },
        // The app-wide authenticated endpoint, alongside.
        mcp: {
          router: AppMcp,
          remote: { enabled: true, url: "https://shop.test/mcp", resolvers: [keys] },
        },
      },
    };
  }
  return new App({ kernel: TestKernel as never });
}

const ran: string[] = [];
let nextId = 1;

function post(
  app: App,
  host: string,
  body: unknown,
  options: { ip?: string; headers?: Record<string, string>; path?: string } = {},
) {
  return app.fetch(
    new Request(`https://${host}${options.path ?? "/api/mcp"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": options.ip ?? "203.0.113.7",
        ...options.headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function rpc(app: App, host: string, method: string, params?: Record<string, unknown>, ip?: string) {
  const response = await post(app, host, { jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }, { ip });
  return { status: response.status, headers: response.headers, body: (await response.json()) as any };
}

function call(app: App, host: string, name: string, args: unknown = {}, ip?: string) {
  return rpc(app, host, "tools/call", { name, arguments: args }, ip);
}

afterEach(() => {
  searched.length = 0;
  ran.length = 0;
  vi.restoreAllMocks();
});

describe("McpEndpoint", () => {
  test("refuses a class that names no caller when it is mounted", () => {
    class Open extends McpEndpoint {
      caller = undefined as never;
      tools = {};
    }
    expect(() => new (class extends ApiRouter {})().mcp(Open)).toThrow(/caller = "anonymous"/);
    expect(() => new (class extends ApiRouter {})().mcp(class {} as never)).toThrow(/McpEndpoint class/);
  });

  test("refuses a malformed twin at mount", () => {
    class Bad extends McpEndpoint {
      caller = "anonymous" as const;
      tools = {
        t: { description: "t", inputSchema: {}, rateLimit: "search" as never, run: () => null },
      };
    }
    expect(() => new (class extends ApiRouter {})().mcp(Bad)).toThrow(/METHOD \/path/);
  });

  test("initialize answers statelessly: no session id", async () => {
    const app = makeApp();
    const { status, headers, body } = await rpc(app, "acme.shop.test", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "inspector", version: "1" },
    });
    expect(status).toBe(200);
    expect(headers.get("mcp-session-id")).toBeNull();
    expect(body.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "shop-ucp", version: "2026-08-25" },
      instructions: "A shop.",
    });
    expect((await rpc(app, "acme.shop.test", "ping")).body.result).toEqual({});
  });

  test("tools/list is decided by the host", async () => {
    const app = makeApp();
    const acme = await rpc(app, "acme.shop.test", "tools/list");
    expect(acme.body.result.tools.map((t: any) => t.name)).toEqual([
      "search_catalog",
      "whereami",
      "cancel_checkout",
      "crash",
      "stale_twin",
    ]);
    const search = acme.body.result.tools[0];
    expect(search).toEqual({
      name: "search_catalog",
      title: "Search the catalog",
      description: "Searches this shop's catalog.",
      inputSchema: {
        type: "object",
        properties: { catalog: { type: "object", properties: { query: { type: "string" } } } },
        required: ["catalog"],
      },
      annotations: { title: "Search the catalog", readOnlyHint: true },
    });
    // An `s` schema is listed as JSON Schema.
    expect(acme.body.result.tools[1].inputSchema).toMatchObject({ type: "object", required: ["echo"] });

    const bare = await rpc(app, "bare.shop.test", "tools/list");
    expect(bare.body.result.tools.map((t: any) => t.name)).toEqual(["whereami", "crash", "stale_twin"]);
  });

  test("a call to a tool the host does not offer is answered as an unknown tool", async () => {
    const app = makeApp();
    for (const name of ["search_catalog", "nope", "toString", "__proto__"]) {
      const { status, body } = await call(app, "bare.shop.test", name, { catalog: { query: "x" } });
      expect(status).toBe(200);
      expect(body.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
    }
    expect(searched).toEqual([]);
  });

  test("a host with no context answers 404 before the body is read", async () => {
    const app = makeApp();
    const response = await post(app, "ghost.shop.test", "not json");
    expect(response.status).toBe(404);
  });

  test("tools see the host's params and the call's _meta", async () => {
    const app = makeApp();
    const { body } = await rpc(app, "acme.shop.test", "tools/call", {
      name: "whereami",
      arguments: { echo: "hi" },
      _meta: { progressToken: 1 },
    });
    expect(body.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ params: { shop: "acme" }, echo: "hi", meta: { progressToken: 1 } }) }],
      structuredContent: { params: { shop: "acme" }, echo: "hi", meta: { progressToken: 1 } },
      isError: false,
    });
  });

  test("an s schema the arguments fail is an error result", async () => {
    const app = makeApp();
    const { body } = await call(app, "acme.shop.test", "whereami", { echo: 1 });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/^Invalid arguments for "whereami"/);
    const notObject = await call(app, "acme.shop.test", "whereami", [1]);
    expect(notObject.body.error.code).toBe(-32602);
  });

  test("results: raw structuredContent, business outcomes as results, protocol errors as errors", async () => {
    const app = makeApp();
    const ok = await call(app, "acme.shop.test", "search_catalog", { catalog: { query: "tea" } });
    expect(ok.body.result.structuredContent).toEqual({ products: [{ id: "p1", title: "tea at acme" }] });
    expect(JSON.parse(ok.body.result.content[0].text)).toEqual(ok.body.result.structuredContent);

    const invalid = await call(app, "acme.shop.test", "search_catalog", { catalog: {} });
    expect(invalid.body.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ messages: [{ code: "invalid", content: "query" }] }) }],
      structuredContent: { messages: [{ code: "invalid", content: "query" }] },
      isError: true,
    });

    const conflict = await call(app, "acme.shop.test", "cancel_checkout");
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      jsonrpc: "2.0",
      id: conflict.body.id,
      error: { code: -32000, message: "Conflict", data: { code: "already_paid" } },
    });
  });

  test("a tool that throws is logged, and the client is told only that it failed", async () => {
    const app = makeApp();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await call(app, "acme.shop.test", "crash");
    expect(status).toBe(200);
    expect(body.result).toEqual({ content: [{ type: "text", text: '"crash" failed on the server.' }], isError: true });
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(log).toHaveBeenCalled();
  });

  test("a tool call and its REST twin spend one counter, in both directions", async () => {
    const app = makeApp();
    const rest = () => post(app, "acme.shop.test", {}, { path: "/api/catalog/search" });

    expect((await rest()).status).toBe(200);
    expect((await call(app, "acme.shop.test", "search_catalog", { catalog: { query: "a" } })).body.result).toBeDefined();
    // The twin's budget (2) is spent: the third, over MCP, is refused before it runs.
    const refused = await call(app, "acme.shop.test", "search_catalog", { catalog: { query: "b" } });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: -32000, message: "Rate limit exceeded" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await rest()).status).toBe(429);
    expect(searched.map((s) => s.via)).toEqual(["rest", "mcp"]);
    // Only the twin's rate limits ran for the tool calls, not the rest of its list.
    expect(ran).toEqual(["auth-free", "auth-free"]);

    // Another address has a budget of its own; MCP first this time.
    const other = "198.51.100.4";
    await call(app, "acme.shop.test", "search_catalog", { catalog: { query: "c" } }, other);
    await call(app, "acme.shop.test", "search_catalog", { catalog: { query: "d" } }, other);
    const restOther = await post(app, "acme.shop.test", {}, { path: "/api/catalog/search", ip: other });
    expect(restOther.status).toBe(429);
  });

  test("a tool's own budget is per address", async () => {
    const app = makeApp();
    expect((await call(app, "acme.shop.test", "cancel_checkout")).status).toBe(409);
    expect((await call(app, "acme.shop.test", "cancel_checkout")).status).toBe(429);
    expect((await call(app, "acme.shop.test", "cancel_checkout", {}, "198.51.100.9")).status).toBe(409);
  });

  test("a twin that is not a route fails the call loudly instead of running unlimited", async () => {
    const app = makeApp();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await call(app, "acme.shop.test", "stale_twin");
    expect(status).toBe(500);
    expect(body.error.code).toBe(-32603);
    expect(String(log.mock.calls[0][1])).toMatch(/POST \/nowhere/);
  });

  test("the endpoint's own per-address budget", async () => {
    class Tight extends ShopMcp {
      rateLimit = { limit: 1, window: 60 };
    }
    const app = makeApp({ endpoint: Tight });
    expect((await rpc(app, "acme.shop.test", "ping")).status).toBe(200);
    const refused = await rpc(app, "acme.shop.test", "ping");
    expect(refused.status).toBe(429);
    expect((await rpc(app, "acme.shop.test", "ping", undefined, "198.51.100.1")).status).toBe(200);
  });

  test("transport: notifications 202, GET and DELETE 405, batches 400, JSON only, known versions", async () => {
    const app = makeApp();
    const note = await post(app, "acme.shop.test", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    const reply = await post(app, "acme.shop.test", { jsonrpc: "2.0", id: 9, result: {} });
    expect(reply.status).toBe(202);

    for (const method of ["GET", "DELETE"]) {
      const response = await app.fetch(new Request("https://acme.shop.test/api/mcp", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }

    expect((await post(app, "acme.shop.test", [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
    expect((await post(app, "acme.shop.test", "{")).status).toBe(400);
    expect(
      (await post(app, "acme.shop.test", { jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "content-type": "text/plain" } }))
        .status,
    ).toBe(415);
    expect(
      (
        await post(app, "acme.shop.test", { jsonrpc: "2.0", id: 1, method: "ping" }, {
          headers: { "mcp-protocol-version": "1999-01-01" },
        })
      ).status,
    ).toBe(400);
    const unknown = await rpc(app, "acme.shop.test", "resources/list");
    expect(unknown.body.error.code).toBe(-32601);
  });

  test("the 2026-07-28 era: server/discover and complete results", async () => {
    const app = makeApp();
    const modern = (method: string, params: Record<string, unknown> = {}, name?: string) =>
      post(
        app,
        "acme.shop.test",
        {
          jsonrpc: "2.0",
          id: nextId++,
          method,
          params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        },
        {
          headers: {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(name ? { "mcp-name": name } : {}),
          },
        },
      ).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

    const discover = await modern("server/discover");
    expect(discover.body.result).toMatchObject({
      resultType: "complete",
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "shop-ucp", version: "2026-08-25" } },
    });
    const called = await modern("tools/call", { name: "search_catalog", arguments: { catalog: { query: "x" } } }, "search_catalog");
    expect(called.body.result).toMatchObject({ resultType: "complete", isError: false });
    // Headers that disagree with the body are refused.
    const mismatch = await modern("tools/call", { name: "search_catalog", arguments: {} }, "crash");
    expect(mismatch.status).toBe(400);
  });

  test("lives beside the app-wide route.mcp.remote, whose resolver guard is untouched", async () => {
    const app = makeApp();
    const remote = await app.fetch(
      new Request("https://shop.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(remote.status).toBe(401);
    expect((await rpc(app, "acme.shop.test", "tools/list")).status).toBe(200);
  });
});
