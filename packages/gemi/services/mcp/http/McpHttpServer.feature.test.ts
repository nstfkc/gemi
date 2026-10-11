import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

process.env.SECRET ??= "mcp-http-feature-test-secret";

import { App } from "../../../app/App";
import { createRoot } from "../../../client/createRoot";
import { ApiRouter, type CreateRPC } from "../../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../../http/AuthenticationMiddlware";
import { HttpRequest } from "../../../http/HttpRequest";
import { McpRouter } from "../../../http/McpRouter";
import { ViewRouter } from "../../../http/ViewRouter";
import { Kernel } from "../../../kernel";
import { defineFeature } from "../../features/defineFeature";
import { StaticFeatureFlagSource } from "../../features/sources/StaticFeatureFlagSource";
import { McpOAuthServer } from "./oauth/McpOAuthServer";
import { MemoryMcpOAuthStore } from "./oauth/store";
import { McpApiKeyResolver } from "./callers";

/**
 * `feature` on the remote MCP endpoint and on its tools (#885), end to end
 * through `App.fetch` with the real `FeatureManager`.
 */

const ALICE = { id: 1, name: "alice" };
const BOB = { id: 2, name: "bob" };
const KEYS: Record<string, { user: any; id: string; scopes: string[] }> = {
  tk_mcp_alice: { user: ALICE, id: "key_a", scopes: ["mcp"] },
  tk_mcp_bob: { user: BOB, id: "key_b", scopes: ["mcp"] },
};

const handled: string[] = [];

class Api extends ApiRouter {
  routes = {
    "/me": this.get(async () => {
      handled.push("me");
      return { id: new HttpRequest<any, any>().ctx().user?.id ?? null };
    }).middleware(["auth"]),
    "/domain": this.get(async () => {
      handled.push("domain");
      return { domain: "acme.test" };
    }).middleware(["auth"]),
    "/beta": this.get(async () => {
      handled.push("beta");
      return { beta: true };
    }).middleware(["auth"]),
  };
}

class Mcp extends McpRouter<CreateRPC<Api>> {
  routes = {
    whoami: this.fromApiRoute("GET", "/me", { description: "Who the user is" }),
    read_domain: this.fromApiRoute("GET", "/domain", {
      description: "The site's domain",
      feature: "custom-domains" as never,
    }),
    beta: this.fromApiRoute("GET", "/beta", {
      description: "Only for alice",
      feature: "alice-only" as never,
    }),
  };
}

const keys = new McpApiKeyResolver({ prefix: "tk_mcp_", verify: async (key) => KEYS[key] ?? null });

function appWith(
  flags: Record<string, boolean>,
  remote: Record<string, unknown> = {},
  onEvaluate?: (key: string) => void,
) {
  class TestKernel extends Kernel {
    config = {
      middleware: { aliases: { auth: AuthenticationMiddleware } },
      features: {
        features: {
          // Server-only, or every page's SSR payload would evaluate it too.
          "mcp-remote": defineFeature({ serverOnly: true }),
          "custom-domains": defineFeature(),
          "alice-only": defineFeature({ when: (ctx) => ctx.user?.id === ALICE.id }),
        },
        source: new StaticFeatureFlagSource(flags),
        ...(onEvaluate ? { onEvaluate } : {}),
      },
      route: {
        api: { rootRouter: Api },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: class extends ViewRouter {},
        },
        mcp: {
          router: Mcp,
          remote: {
            enabled: true,
            url: "https://shop.test/mcp",
            resolvers: [keys],
            server: { name: "shop", version: "1.2.3" },
            ...remote,
          },
        },
      },
    };
  }
  return new App({ kernel: TestKernel });
}

const MODERN = "2026-07-28";
let nextId = 1;

function modern(app: App, method: string, params: Record<string, unknown> = {}, key = "tk_mcp_alice") {
  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  return app.fetch(
    new Request("https://shop.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${key}`,
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": method,
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function toolNames(app: App, key?: string): Promise<string[]> {
  const res = await modern(app, "tools/list", {}, key);
  const json: any = await res.json();
  return json.result.tools.map((tool: { name: string }) => tool.name);
}

/** Whether the MCP layer answered: a real `Response`, not the view dispatcher's render function. */
function answeredByMcp(res: unknown): res is Response {
  return res instanceof Response;
}

beforeEach(() => {
  handled.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route.mcp.remote.feature", () => {
  const oauth = () =>
    new McpOAuthServer({
      store: new MemoryMcpOAuthStore(),
      findUser: async () => ALICE,
      consent: { signInPath: "/sign-in" },
    } as any);

  test("off: the endpoint and its OAuth endpoints fall through to the app", async () => {
    const app = appWith({}, { feature: "mcp-remote", resolvers: [oauth(), keys] });
    await app.waitForBoot();

    const endpoint: unknown = await modern(app, "tools/list");
    expect(answeredByMcp(endpoint) && endpoint.status === 200).toBe(false);

    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res: unknown = await app.fetch(new Request(`https://shop.test${path}`));
      expect(answeredByMcp(res) && res.status === 200).toBe(false);
    }
    const register: unknown = await app.fetch(
      new Request("https://shop.test/mcp/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.test/cb"] }),
      }),
    );
    expect(answeredByMcp(register) && register.status === 201).toBe(false);
  });

  test("on: served as without a feature", async () => {
    const app = appWith({ "mcp-remote": true, "custom-domains": true }, {
      feature: "mcp-remote",
      resolvers: [oauth(), keys],
    });
    const res = await modern(app, "tools/list");
    expect(res.status).toBe(200);
    const meta: unknown = await app.fetch(
      new Request("https://shop.test/.well-known/oauth-authorization-server"),
    );
    expect(answeredByMcp(meta) && meta.status).toBe(200);
  });

  test("evaluated only for paths the endpoint can own", async () => {
    const seen: string[] = [];
    const app = appWith({ "mcp-remote": true }, { feature: "mcp-remote" }, (key) => seen.push(key));
    await app.waitForBoot();
    await app.fetch(new Request("https://shop.test/about"));
    await app.fetch(new Request("https://shop.test/api/me"));
    expect(seen.filter((key) => key === "mcp-remote")).toEqual([]);

    await modern(app, "tools/list");
    expect(seen).toContain("mcp-remote");
  });

  test("the boot refuses a feature that is not a key", async () => {
    await expect(appWith({}, { feature: "" }).waitForBoot()).rejects.toThrow(
      /route\.mcp\.remote\.feature must be a feature key/,
    );
  });
});

describe("feature on a tool", () => {
  test("off: left out of tools/list, and a call is an unknown tool", async () => {
    const app = appWith({});
    expect(await toolNames(app)).toEqual(["whoami"]);

    const res = await modern(app, "tools/call", { name: "read_domain", arguments: {} });
    const json: any = await res.json();
    expect(json.error.message).toBe("Unknown tool: read_domain");
    expect(handled).toEqual([]);
  });

  test("on: listed and called", async () => {
    const app = appWith({ "custom-domains": true });
    expect(await toolNames(app)).toEqual(["whoami", "read_domain"]);

    const res = await modern(app, "tools/call", { name: "read_domain", arguments: {} });
    const json: any = await res.json();
    expect(json.result.isError).toBe(false);
    expect(handled).toEqual(["domain"]);
  });

  test("evaluated as the credential's user, so a `when` targets callers", async () => {
    const app = appWith({ "alice-only": true });
    expect(await toolNames(app, "tk_mcp_alice")).toEqual(["whoami", "beta"]);
    expect(await toolNames(app, "tk_mcp_bob")).toEqual(["whoami"]);

    const res = await modern(app, "tools/call", { name: "beta", arguments: {} }, "tk_mcp_bob");
    expect(((await res.json()) as any).error.message).toBe("Unknown tool: beta");
  });

  test("server version does not move with the flags", async () => {
    const versionOf = async (app: App, key: string) => {
      const res = await modern(app, "server/discover", {}, key);
      return ((await res.json()) as any).result._meta["io.modelcontextprotocol/serverInfo"].version;
    };
    const app = appWith({ "alice-only": true });
    expect(await versionOf(app, "tk_mcp_alice")).toBe("1.2.3");
    expect(await versionOf(app, "tk_mcp_bob")).toBe("1.2.3");
  });
});
