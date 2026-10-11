import { describe, expect, test, vi } from "vitest";

import { ApiRouter, type CreateRPC } from "../../http/ApiRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { McpRouter } from "../../http/McpRouter";
import { ApiRouteDispatcher } from "../router/ApiRouteDispatcher";
import { createFlatApiRoutes } from "../router/createFlatApiRoutes";
import { McpCallRefusedError, McpRegistry, McpToolError, type McpCaller } from "./McpRegistry";

/**
 * A tool's `feature` (#885), on the registry alone: `available` narrows `list`
 * by it, `execute` refuses a tool whose feature is off, for local and remote
 * callers, and `list`/`descriptors` are unchanged.
 */

class Api extends ApiRouter {
  routes = {
    "/me": this.get(async () => ({ id: 1 })),
    "/domain": this.get(async () => ({ domain: "acme.test" })),
  };
}

class Mcp extends McpRouter<CreateRPC<Api>> {
  routes = {
    whoami: this.fromApiRoute("GET", "/me", { description: "Who" }),
    read_domain: this.fromApiRoute("GET", "/domain", {
      description: "Domain",
      feature: "custom-domains" as never,
    }),
  };
}

function registry(flags: Record<string, boolean>) {
  const dispatchAs = vi.fn(async () => Response.json({ ok: true }));
  const featureOn = vi.fn(async (key: string) => flags[key] === true);
  const built = new McpRegistry(
    new Mcp(),
    {
      flatRoutes: createFlatApiRoutes({ "/": Api }),
      dispatchAs,
      getRouteHandlerAndParams: ApiRouteDispatcher.prototype.getRouteHandlerAndParams,
    } as any,
    { featureOn },
  );
  return { registry: built, dispatchAs, featureOn };
}

const req = new HttpRequest(new Request("http://gemi.dev/api/agent"));
const local: McpCaller = { kind: "local", req };
const remote: McpCaller = {
  kind: "remote",
  req,
  principal: { user: { id: 1 }, via: "api-key", id: "k1", scopes: ["mcp"] },
};

describe("a tool's feature", () => {
  test("the descriptor carries it; list and descriptors ignore it", () => {
    const { registry: r, featureOn } = registry({});
    expect(r.descriptors().map((tool) => [tool.name, tool.feature])).toEqual([
      ["whoami", undefined],
      ["read_domain", "custom-domains"],
    ]);
    expect(r.list(local).map((tool) => tool.name)).toEqual(["whoami", "read_domain"]);
    expect(featureOn).not.toHaveBeenCalled();
  });

  test("available leaves out a tool whose feature is off, for both callers", async () => {
    const off = registry({}).registry;
    expect((await off.available(local)).map((tool) => tool.name)).toEqual(["whoami"]);
    expect((await off.available(remote)).map((tool) => tool.name)).toEqual(["whoami"]);

    const on = registry({ "custom-domains": true }).registry;
    expect((await on.available(remote)).map((tool) => tool.name)).toEqual(["whoami", "read_domain"]);
  });

  test("available evaluates only gated tools that pass the filter", async () => {
    const { registry: r, featureOn } = registry({});
    await r.available(local, { names: ["whoami"] });
    expect(featureOn).not.toHaveBeenCalled();
  });

  test("a remote call to a tool whose feature is off is an unknown tool", async () => {
    const { registry: r, dispatchAs } = registry({});
    const error = await r.execute(remote, "read_domain", {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(McpCallRefusedError);
    expect((error as McpCallRefusedError).reason).toBe("unknown-tool");
    expect(dispatchAs).not.toHaveBeenCalled();
  });

  test("a local call to a tool whose feature is off is a tool error the model reads", async () => {
    const { registry: r, dispatchAs } = registry({});
    const error = await r.execute(local, "read_domain", {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as Error).message).toBe('There is no tool named "read_domain".');
    expect(dispatchAs).not.toHaveBeenCalled();
  });

  test("on: the call is dispatched", async () => {
    const { registry: r, dispatchAs } = registry({ "custom-domains": true });
    expect(await r.execute(local, "read_domain", {})).toEqual({ ok: true });
    expect(dispatchAs).toHaveBeenCalledTimes(1);
  });

  test("the boot refuses a feature that is not a key", () => {
    class Bad extends McpRouter<CreateRPC<Api>> {
      routes = {
        whoami: this.fromApiRoute("GET", "/me", { description: "Who", feature: "" as never }),
      };
    }
    expect(
      () =>
        new McpRegistry(new Bad(), {
          flatRoutes: createFlatApiRoutes({ "/": Api }),
        } as any),
    ).toThrow(/feature must be a feature key/);
  });
});
