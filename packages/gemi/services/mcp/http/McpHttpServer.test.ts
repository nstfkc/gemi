import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

process.env.SECRET ??= "mcp-http-test-secret";

import { s } from "../../../ai/Schema";
import { App } from "../../../app/App";
import { createRoot } from "../../../client/createRoot";
import { ApiRouter, type CreateRPC } from "../../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../../http/AuthenticationMiddlware";
import { HttpRequest } from "../../../http/HttpRequest";
import { McpRouter } from "../../../http/McpRouter";
import { ViewRouter } from "../../../http/ViewRouter";
import { Kernel } from "../../../kernel";
import { McpToolError } from "../McpRegistry";
import { McpApiKeyResolver } from "./callers";
import { sign } from "./signedState";

/**
 * The MCP endpoint end to end, through `App.fetch`: a client with an API key
 * talks Streamable HTTP to `/mcp`, in both protocol eras, and its tool calls
 * reach the app's routes as the key's user.
 */

const ALICE = { id: 1, name: "alice", orgId: "org_alice" };
const BOB = { id: 2, name: "bob", orgId: "org_bob" };

const KEYS: Record<string, { user: any; id: string; scopes: string[] }> = {
  "tk_mcp_alice": { user: ALICE, id: "key_a", scopes: ["site:read", "site:write"] },
  "tk_mcp_reader": { user: BOB, id: "key_b", scopes: ["site:read"] },
};

const handled: { route: string; user: number | null; detail?: unknown }[] = [];
const userOf = (req: HttpRequest<any, any>) => req.ctx().user?.id ?? null;
let slow: (req: HttpRequest<any, any>) => Promise<unknown> = async () => ({});

class Api extends ApiRouter {
  routes = {
    "/me": this.get(async () => {
      const req = new HttpRequest<any, any>();
      handled.push({ route: "me", user: userOf(req) });
      return {
        id: userOf(req),
        grant: req.mcpGrant(),
        authorization: req.rawRequest.headers.get("authorization"),
      };
    }).middleware(["auth"]),
    "/:orgId/pages": this.get(async (_: HttpRequest<{}, { orgId: string }>) => {
      const req = new HttpRequest<{}, { orgId: string }>();
      handled.push({ route: "pages", user: userOf(req), detail: req.params });
      return [{ path: "/about", orgId: req.params.orgId, html: "<main/>" }];
    }).middleware(["auth"]),
    "/pages/:id": this.delete(async () => {
      const req = new HttpRequest<any, any>();
      handled.push({ route: "delete-page", user: userOf(req), detail: req.params });
      return { deleted: req.params.id };
    }).middleware(["auth"]),
    "/slow": this.post(async () => slow(new HttpRequest<any, any>())).middleware(["auth"]),
    "/refuse": this.post(async () => {
      throw new McpToolError("never");
    }),
    "/hello": this.get(async () => ({ hello: "from the app" })),
  };
}

class Mcp extends McpRouter<CreateRPC<Api>> {
  scopes = {
    "site:read": { description: "Read your site", tags: ["read"] },
    "site:write": { description: "Edit your site", tags: ["write"] },
  };
  routes = {
    whoami: this.fromApiRoute("GET", "/me", { description: "Who the user is", tags: ["read"] }),
    "list-pages": this.fromApiRoute("GET", "/:orgId/pages", {
      description: "List the pages",
      title: "List pages",
      params: { orgId: (req) => req.ctx().user.orgId },
      result: (pages) => ({ pages: pages.map(({ path }) => ({ path })) }),
      output: s.object({ pages: s.array(s.object({ path: s.string() })) }),
      tags: ["read"],
    }),
    "delete-page": this.fromApiRoute("DELETE", "/pages/:id", {
      description: "Delete a page",
      params: { id: "input" },
      requiresApproval: true,
      tags: ["write"],
    }),
    slow: this.fromApiRoute("POST", "/slow", { description: "Takes a while", tags: ["write"] }),
  };
}

const resolver = new McpApiKeyResolver({
  prefix: "tk_mcp_",
  verify: async (key) => KEYS[key] ?? null,
});

function kernelWith(remote: Record<string, unknown> | undefined) {
  return class extends Kernel {
    config = {
      middleware: { aliases: { auth: AuthenticationMiddleware } },
      route: {
        api: { rootRouter: Api },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: class extends ViewRouter {},
        },
        mcp: { router: Mcp, ...(remote ? { remote } : {}) },
      },
    };
  };
}

const REMOTE = {
  enabled: true,
  url: "https://shop.test/mcp",
  resolvers: [resolver],
  allowedOrigins: ["https://inspector.test"],
  server: { name: "shop", version: "1.2.3" },
  approvalTimeoutMs: 2000,
};

const app = new App({ kernel: kernelWith(REMOTE) });

const MODERN = "2026-07-28";

let nextId = 1;

/** A modern request, with the headers the transport requires. */
function modern(
  method: string,
  params: Record<string, unknown> = {},
  options: { key?: string | null; headers?: Record<string, string>; capabilities?: unknown } = {},
) {
  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": options.capabilities ?? {},
        ...(params._meta as object),
      },
    },
  };
  return post(body, {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": method,
    ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    ...options.headers,
  }, options.key);
}

function post(body: unknown, headers: Record<string, string> = {}, key: string | null = "tk_mcp_alice") {
  return app.fetch(
    new Request("https://shop.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** The messages of an SSE body. */
async function events(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data: "))
    .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6)));
}

beforeEach(() => {
  handled.length = 0;
  slow = async () => ({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mounting", () => {
  test("off by default: no endpoint, the app's routes answer", async () => {
    for (const remote of [undefined, { ...REMOTE, enabled: false }]) {
      const off = new App({ kernel: kernelWith(remote) });
      const res: any = await off.fetch(
        new Request("https://shop.test/mcp", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        }),
      );
      // A view route's render function, not the endpoint's 401.
      expect(res instanceof Response ? res.headers.get("WWW-Authenticate") : null).toBeNull();
    }
  });

  test("the boot refuses an endpoint without a resolver, or with a bad url", async () => {
    const boot = (remote: Record<string, unknown>) => new App({ kernel: kernelWith(remote) }).waitForBoot();
    await expect(boot({ enabled: true, url: "https://shop.test/mcp" })).rejects.toThrow(
      /enabled without a caller resolver/,
    );
    await expect(boot({ ...REMOTE, resolvers: [] })).rejects.toThrow(/enabled without a caller resolver/);
    await expect(boot({ ...REMOTE, url: undefined })).rejects.toThrow(/url is required/);
    await expect(boot({ ...REMOTE, url: "http://shop.test/mcp" })).rejects.toThrow(/must be https/);
    await expect(boot({ ...REMOTE, url: "https://shop.test/" })).rejects.toThrow(/needs a path of its own/);
    await expect(boot({ ...REMOTE, enabled: "yes" })).rejects.toThrow(/enabled must be true or false/);
    await expect(boot({ ...REMOTE, allowedOrigins: ["https://a.test/x"] })).rejects.toThrow(
      /is not an origin/,
    );
    await expect(boot({ ...REMOTE, resolvers: [{ resolve: async () => null }] })).rejects.toThrow(
      /each resolver needs a name/,
    );
  });

  test("the boot refuses an endpoint without SECRET", async () => {
    const secret = process.env.SECRET;
    delete process.env.SECRET;
    try {
      await expect(new App({ kernel: kernelWith(REMOTE) }).waitForBoot()).rejects.toThrow(/SECRET/);
    } finally {
      process.env.SECRET = secret;
    }
  });

  test("http is accepted on localhost", async () => {
    await expect(
      new App({ kernel: kernelWith({ ...REMOTE, url: "http://localhost:5173/mcp" }) }).waitForBoot(),
    ).resolves.toBeUndefined();
  });

  test("another host is not answered by the endpoint (DNS rebinding)", async () => {
    const res = await app.fetch(
      new Request("https://attacker.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tk_mcp_alice" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    // Routed as any request to that host would be: a view, not the endpoint.
    expect(res).not.toBeInstanceOf(Response);
    expect(handled).toEqual([]);
  });

  test("other paths on the host are the app's", async () => {
    const res = await app.fetch(new Request("https://shop.test/api/hello"));
    expect(await res.json()).toEqual({ hello: "from the app" });
  });
});

describe("authentication", () => {
  test("no credential is 401 with a challenge", async () => {
    const res = await modern("tools/list", {}, { key: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="mcp"');
  });

  test("an unknown key is 401 invalid_token", async () => {
    const res = await modern("tools/list", {}, { key: "tk_mcp_nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/error="invalid_token"/);
  });

  test("a bearer token without the prefix is nobody's", async () => {
    const res = await modern("tools/list", {}, { key: "some-other-token" });
    expect(res.status).toBe(401);
  });

  test("a token in the query string is not read", async () => {
    const res = await app.fetch(
      new Request("https://shop.test/mcp?access_token=tk_mcp_alice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("a gemi session cookie is not a credential here", async () => {
    const res = await app.fetch(
      new Request("https://shop.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "access_token=v2.anything" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("the resolver must answer a well-formed key", () => {
    expect(() => new McpApiKeyResolver({ prefix: "x", verify: async () => null })).toThrow(/prefix is required/);
    expect(McpApiKeyResolver.generate("tk_mcp_")).toMatch(/^tk_mcp_[A-Za-z0-9_-]{43}$/);
    expect(McpApiKeyResolver.hash("k")).toHaveLength(64);
  });
});

describe("origin", () => {
  test("a foreign Origin is refused", async () => {
    const res = await modern("tools/list", {}, { headers: { Origin: "https://evil.test" } });
    expect(res.status).toBe(403);
    expect(handled).toEqual([]);
  });

  test("the null origin is refused", async () => {
    const res = await modern("tools/list", {}, { headers: { Origin: "null" } });
    expect(res.status).toBe(403);
  });

  test("an allowed origin gets CORS headers, and a preflight", async () => {
    const res = await modern("tools/list", {}, { headers: { Origin: "https://inspector.test" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://inspector.test");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const preflight = await app.fetch(
      new Request("https://shop.test/mcp", { method: "OPTIONS", headers: { Origin: "https://inspector.test" } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
  });

  test("the endpoint's own origin is allowed", async () => {
    const res = await modern("tools/list", {}, { headers: { Origin: "https://shop.test" } });
    expect(res.status).toBe(200);
  });
});

describe("the HTTP surface", () => {
  test("GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.fetch(
        new Request("https://shop.test/mcp", { method, headers: { Authorization: "Bearer tk_mcp_alice" } }),
      );
      expect(res.status).toBe(405);
    }
  });

  test("a body that is not JSON, not JSON-RPC, or a batch", async () => {
    expect((await post("{nope", {})).status).toBe(400);
    expect((await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])).status).toBe(400);
    expect((await post({ id: 1, method: "tools/list" })).status).toBe(400);
    const res = await app.fetch(
      new Request("https://shop.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer tk_mcp_alice", "Content-Type": "text/plain" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(415);
  });

  test("a body over the limit is 413, before it is parsed", async () => {
    const small = new App({ kernel: kernelWith({ ...REMOTE, maxBodyBytes: 100 }) });
    const res = await small.fetch(
      new Request("https://shop.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer tk_mcp_alice", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(200) } }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("each credential has its own budget at the endpoint", async () => {
    const limited = new App({ kernel: kernelWith({ ...REMOTE, rateLimit: { limit: 2, window: 60 } }) });
    const call = (key: string) =>
      limited.fetch(
        new Request("https://shop.test/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
    expect((await call("tk_mcp_alice")).status).toBe(400);
    expect((await call("tk_mcp_alice")).status).toBe(400);
    const third = await call("tk_mcp_alice");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await call("tk_mcp_reader")).status).toBe(400);
  });
});

describe("a modern client (2026-07-28)", () => {
  test("server/discover", async () => {
    const res = await modern("server/discover");
    const body = await res.json();
    expect(body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "shop", version: "1.2.3" } },
    });
  });

  test("tools/list answers what the key's scopes reach, with schemas and annotations", async () => {
    const all = (await (await modern("tools/list")).json()).result;
    expect(all).toMatchObject({ resultType: "complete", cacheScope: "private" });
    expect(all.tools.map((tool: any) => tool.name)).toEqual(["whoami", "list-pages", "delete-page", "slow"]);
    const listPages = all.tools.find((tool: any) => tool.name === "list-pages");
    expect(listPages).toMatchObject({
      title: "List pages",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    expect(listPages.inputSchema.properties).not.toHaveProperty("orgId");

    const reader = (await (await modern("tools/list", {}, { key: "tk_mcp_reader" })).json()).result;
    expect(reader.tools.map((tool: any) => tool.name)).toEqual(["whoami", "list-pages"]);
  });

  test("tools/call runs as the key's user, with no bearer token passed on", async () => {
    const res = await modern("tools/call", { name: "whoami", arguments: {} });
    const { result } = await res.json();
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: ALICE.id,
      grant: { via: "api-key", id: "key_a", scopes: ["site:read", "site:write"] },
      authorization: null,
    });
  });

  test("a binder reads the key's user, and structuredContent follows the output schema", async () => {
    const { result } = await (await modern("tools/call", { name: "list-pages", arguments: {} }, { key: "tk_mcp_reader" })).json();
    expect(result.structuredContent).toEqual({ pages: [{ path: "/about" }] });
    expect(handled).toEqual([{ route: "pages", user: BOB.id, detail: { orgId: BOB.orgId } }]);
  });

  test("a tool error is isError, a tool out of scope is unknown", async () => {
    const invalid = await (await modern("tools/call", { name: "delete-page", arguments: {} }, { capabilities: { elicitation: {} } })).json();
    // Missing "id": refused before the user is asked to approve it.
    expect(invalid.result).toMatchObject({ resultType: "complete", isError: true });
    expect(invalid.result.content[0].text).toMatch(/Invalid arguments for "delete-page"/);

    const hidden = await (await modern("tools/call", { name: "slow", arguments: {} }, { key: "tk_mcp_reader" })).json();
    expect(hidden.error).toMatchObject({ code: -32602, message: "Unknown tool: slow" });
    const missing = await (await modern("tools/call", { name: "nope", arguments: {} })).json();
    expect(missing.error).toMatchObject({ code: -32602, message: "Unknown tool: nope" });
    expect(handled).toEqual([]);
  });

  test("invalid arguments are a tool error the model can read", async () => {
    const { result } = await (await modern("tools/call", { name: "whoami", arguments: { extra: 1 } })).json();
    expect(result).toMatchObject({ isError: false });
    const bad = await (await modern("tools/call", { name: "whoami", arguments: "nope" })).json();
    expect(bad.result).toMatchObject({ isError: true });
    expect(bad.result.content[0].text).toMatch(/Invalid arguments/);
  });

  test("an unknown method is 404 -32601", async () => {
    const res = await modern("resources/list");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe(-32601);
  });

  test("an unsupported version lists the supported ones", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
      },
      { "MCP-Protocol-Version": "1900-01-01", "Mcp-Method": "tools/list" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({
      code: -32022,
      data: { supported: expect.arrayContaining(["2026-07-28"]), requested: "1900-01-01" },
    });
  });

  test("headers that disagree with the body are refused", async () => {
    const cases: Record<string, string>[] = [
      { "MCP-Protocol-Version": "2025-11-25" },
      { "Mcp-Method": "tools/list" },
      { "Mcp-Name": "delete-page" },
    ];
    for (const headers of cases) {
      const res = await modern("tools/call", { name: "whoami", arguments: {} }, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(400);
      expect((await res.json()).error.code).toBe(-32020);
    }
    // A missing Mcp-Name is a mismatch too.
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
      },
      { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" },
    );
    expect(res.status).toBe(400);
    expect(handled).toEqual([]);
  });

  test("Mcp-Name in the base64 sentinel is decoded before it is compared", async () => {
    const res = await modern(
      "tools/call",
      { name: "whoami", arguments: {} },
      { headers: { "Mcp-Name": `=?base64?${Buffer.from("whoami").toString("base64")}?=` } },
    );
    expect(res.status).toBe(200);
  });

  test("progress reaches the client on the call's stream, in order", async () => {
    slow = async (req) => {
      req.reportProgress({ progress: 1, total: 3, message: "one" });
      req.reportProgress({ progress: 1, total: 3, message: "again" });
      req.reportProgress({ progress: 3, total: 3 });
      return { done: true };
    };
    const res = await modern("tools/call", { name: "slow", arguments: {}, _meta: { progressToken: "p1" } });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const messages = await events(res);
    expect(messages.map((m) => m.method ?? "result")).toEqual([
      "notifications/progress",
      "notifications/progress",
      "result",
    ]);
    expect(messages[0].params).toEqual({ progressToken: "p1", progress: 1, total: 3, message: "one" });
    expect(messages[1].params).toEqual({ progressToken: "p1", progress: 3, total: 3 });
    expect(messages[2].result.structuredContent).toBeUndefined();
    expect(JSON.parse(messages[2].result.content[0].text)).toEqual({ done: true });
  });

  test("without a progressToken a report goes nowhere and the call answers JSON", async () => {
    let delivered: boolean | undefined;
    slow = async (req) => {
      delivered = req.reportProgress({ progress: 1 });
      return {};
    };
    const res = await modern("tools/call", { name: "slow", arguments: {} });
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(delivered).toBe(false);
  });

  test("closing the stream aborts the route's signal", async () => {
    let aborted!: Promise<boolean>;
    slow = async (req) => {
      aborted = new Promise((resolve) => req.signal.addEventListener("abort", () => resolve(true)));
      req.reportProgress({ progress: 1 });
      await aborted;
      return {};
    };
    const res = await modern("tools/call", { name: "slow", arguments: {}, _meta: { progressToken: 1 } });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(await aborted).toBe(true);
  });

  describe("approval (requiresApproval → elicitation)", () => {
    const elicitation = { capabilities: { elicitation: { form: {} } } };
    const ask = (args: unknown = { id: "pg_1" }, options = elicitation) =>
      modern("tools/call", { name: "delete-page", arguments: args }, options);
    const answer = (requestState: string, action: string, content?: unknown, args: unknown = { id: "pg_1" }, key = "tk_mcp_alice") =>
      modern(
        "tools/call",
        {
          name: "delete-page",
          arguments: args,
          requestState,
          inputResponses: { gemi_approval: { action, ...(content ? { content } : {}) } },
        },
        { ...elicitation, key },
      );

    test("a client that cannot ask is refused, and nothing runs", async () => {
      const res = await ask({ id: "pg_1" }, { capabilities: {} });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatchObject({ code: -32021 });
      expect(handled).toEqual([]);
    });

    test("asks with a form, and runs once the user approves", async () => {
      const first = (await (await ask()).json()).result;
      expect(first).toMatchObject({
        resultType: "input_required",
        inputRequests: {
          gemi_approval: {
            method: "elicitation/create",
            params: { mode: "form", requestedSchema: { required: ["approve"] } },
          },
        },
      });
      expect(first.inputRequests.gemi_approval.params.message).toMatch(/Delete a page[\s\S]*pg_1/);
      expect(handled).toEqual([]);

      const second = (await (await answer(first.requestState, "accept", { approve: true })).json()).result;
      expect(second).toMatchObject({ resultType: "complete", isError: false });
      expect(handled).toEqual([{ route: "delete-page", user: ALICE.id, detail: { id: "pg_1" } }]);

      // The same approval cannot run the call again.
      const replay = await (await answer(first.requestState, "accept", { approve: true })).json();
      expect(replay.error.message).toMatch(/already been used/);
      expect(handled).toHaveLength(1);
    });

    test("arguments too long to show are cut, and the prompt says so", async () => {
      const id = `pg_${"x".repeat(3000)}_tail`;
      const { message } = (await (await ask({ id })).json()).result.inputRequests.gemi_approval.params;
      expect(message).toMatch(/more characters not shown\)$/);
      expect(message).not.toMatch(/_tail/);
    });

    test("a decline, a cancel, or an accept without approve does not run it", async () => {
      for (const [action, content] of [["decline"], ["cancel"], ["accept", { approve: false }], ["accept", {}]] as const) {
        const { requestState } = (await (await ask()).json()).result;
        const { result } = await (await answer(requestState, action, content)).json();
        expect(result).toMatchObject({ isError: true });
        expect(result.content[0].text).toMatch(/did not approve/);
      }
      expect(handled).toEqual([]);
    });

    test("an approval is bound to its arguments, its credential and its signature", async () => {
      const { requestState } = (await (await ask()).json()).result;
      const otherArgs = await (await answer(requestState, "accept", { approve: true }, { id: "pg_2" })).json();
      expect(otherArgs.error.message).toMatch(/not valid for this call/);

      const KEYS_WRITE = KEYS;
      KEYS_WRITE["tk_mcp_bob_writer"] = { user: BOB, id: "key_c", scopes: ["site:write"] };
      const otherKey = await (await answer(requestState, "accept", { approve: true }, { id: "pg_1" }, "tk_mcp_bob_writer")).json();
      expect(otherKey.error.message).toMatch(/not valid for this call/);

      const [tag, body, mac] = requestState.split(".");
      const payload = JSON.parse(Buffer.from(body, "base64url").toString());
      const forged = `${tag}.${Buffer.from(JSON.stringify({ ...payload, t: "slow" })).toString("base64url")}.${mac}`;
      const tampered = await (await answer(forged, "accept", { approve: true })).json();
      expect(tampered.error.message).toMatch(/not valid for this call/);

      const expired = sign("gemi.mcp.request-state.v1", "grs1", { ...payload, exp: Date.now() - 1 });
      const late = await (await answer(expired, "accept", { approve: true })).json();
      expect(late.error.message).toMatch(/not valid for this call/);

      // A session id is signed for another purpose and never verifies as state.
      const session = sign("gemi.mcp.session.v1", "grs1", { ...payload });
      const crossed = await (await answer(session, "accept", { approve: true })).json();
      expect(crossed.error.message).toMatch(/not valid for this call/);
      expect(handled).toEqual([]);
    });
  });
});

describe("a legacy client (initialize, Mcp-Session-Id)", () => {
  async function initialize(options: { key?: string; version?: string; capabilities?: unknown } = {}) {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: options.version ?? "2025-06-18",
          capabilities: options.capabilities ?? {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      {},
      options.key ?? "tk_mcp_alice",
    );
    return { res, session: res.headers.get("Mcp-Session-Id")!, body: await res.json() };
  }

  const legacy = (session: string | null, body: unknown, key = "tk_mcp_alice", headers: Record<string, string> = {}) =>
    post(body, { ...(session ? { "Mcp-Session-Id": session } : {}), ...headers }, key);

  test("initialize negotiates a version and opens a session", async () => {
    const { body, session } = await initialize();
    expect(body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "shop", version: "1.2.3" },
    });
    expect(session).toMatch(/^gms1\./);

    const unknown = await initialize({ version: "2024-01-01" });
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");
  });

  test("calls in the session; outputSchema only when it is an object", async () => {
    const { session } = await initialize();
    expect((await legacy(session, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await (await legacy(session, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    expect(list.result.tools.map((tool: any) => tool.name)).toEqual(["whoami", "list-pages", "delete-page", "slow"]);
    expect(list.result).not.toHaveProperty("resultType");
    expect(list.result.tools.find((t: any) => t.name === "list-pages").annotations).toMatchObject({
      title: "List pages",
    });

    const call = await (
      await legacy(session, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list-pages", arguments: {} } })
    ).json();
    expect(call.result).toMatchObject({ isError: false, structuredContent: { pages: [{ path: "/about" }] } });
    expect(call.result).not.toHaveProperty("resultType");
    expect((await (await legacy(session, { jsonrpc: "2.0", id: 3, method: "ping" })).json()).result).toEqual({});
  });

  test("a request without a session is 400; a forged or foreign one is 404", async () => {
    expect((await legacy(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(400);
    expect((await legacy("gms1.bogus.sig", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);

    // Session fixation: Alice's session id, presented with the reader's key.
    const { session } = await initialize();
    const res = await legacy(session, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "tk_mcp_reader");
    expect(res.status).toBe(404);
  });

  test("an MCP-Protocol-Version that is not the session's is refused", async () => {
    const { session } = await initialize({ version: "2025-06-18" });
    const res = await legacy(session, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "tk_mcp_alice", {
      "MCP-Protocol-Version": "2025-11-25",
    });
    expect(res.status).toBe(400);
  });

  test("approval: refused without elicitation, asked on the stream with it", async () => {
    const plain = await initialize();
    const refused = await (
      await legacy(plain.session, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete-page", arguments: { id: "pg_1" } } })
    ).json();
    expect(refused.result).toMatchObject({ isError: true });
    expect(handled).toEqual([]);

    const { session } = await initialize({ version: "2025-11-25", capabilities: { elicitation: {} } });
    const res = await legacy(session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete-page", arguments: { id: "pg_1" } },
    });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]);
    expect(first).toMatchObject({ method: "elicitation/create", params: { mode: "form" } });
    expect(handled).toEqual([]);

    // Another credential's answer is ignored.
    await legacy(session, { jsonrpc: "2.0", id: first.id, result: { action: "accept", content: { approve: true } } }, "tk_mcp_reader");
    // The session's own answer goes through.
    const ack = await legacy(session, { jsonrpc: "2.0", id: first.id, result: { action: "accept", content: { approve: true } } });
    expect(ack.status).toBe(202);

    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const final = JSON.parse(rest.split("data: ")[1]);
    expect(final).toMatchObject({ id: 2, result: { isError: false } });
    expect(handled).toEqual([{ route: "delete-page", user: ALICE.id, detail: { id: "pg_1" } }]);
  });

  test("approval: a decline does not run it", async () => {
    const { session } = await initialize({ capabilities: { elicitation: {} } });
    const res = await legacy(session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete-page", arguments: { id: "pg_1" } },
    });
    const reader = res.body!.getReader();
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]);
    expect(first.params).not.toHaveProperty("mode");
    await legacy(session, { jsonrpc: "2.0", id: first.id, result: { action: "decline" } });
    const rest = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(rest.split("data: ")[1]).result).toMatchObject({ isError: true });
    expect(handled).toEqual([]);
  });

  test("approval: an unanswered prompt times out without running", async () => {
    const { session } = await initialize({ capabilities: { elicitation: {} } });
    const res = await legacy(session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete-page", arguments: { id: "pg_1" } },
    });
    const messages = await events(res);
    expect(messages.at(-1).result).toMatchObject({ isError: true });
    expect(handled).toEqual([]);
  }, 10_000);
});
