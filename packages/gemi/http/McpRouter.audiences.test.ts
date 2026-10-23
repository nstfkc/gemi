import { describe, expect, test } from "vitest";

import { s } from "../ai/Schema";
import { McpRouteDeclaration, McpRouter, recaseName } from "./McpRouter";

/**
 * `fromApiRouteFor` at runtime (#1018): what it expands to. The registry's
 * side, the tools these become, is in `McpRegistry.test.ts`.
 */

// Untyped: these tests are about the expansion, not about the route table.
const router = new McpRouter<any>() as McpRouter<any> & {
  fromApiRouteFor: (...args: any[]) => Record<string, McpRouteDeclaration>;
};

describe("recaseName", () => {
  test.each([
    ["list_pages", "camel", "listPages"],
    ["listPages", "snake", "list_pages"],
    ["list-page-access", "camel", "listPageAccess"],
    ["readPageAccess", "kebab", "read-page-access"],
    ["get_v2_items", "camel", "getV2Items"],
    ["health", "snake", "health"],
  ] as const)("%s as %s is %s", (name, casing, expected) => {
    expect(recaseName(name, casing)).toBe(expected);
  });
});

describe("fromApiRouteFor", () => {
  const binder = () => "org_1";

  test("expands to one declaration per audience, the audience's keys over the shared ones", () => {
    const result = (data: unknown) => data;
    const own = (data: unknown) => ({ own: data });
    const tools = router.fromApiRouteFor("POST", "/:orgId/products", {
      name: "create_product",
      description: "Creates a product.",
      input: s.object({ name: s.string() }),
      params: { orgId: "input" },
      files: { image: "input" },
      tags: ["products"],
      requiresApproval: true,
      result,
      audiences: {
        agent: { casing: "camel", params: { orgId: binder } },
        remote: {
          title: "Create a product",
          description: (shared: string) => `${shared} Name the org.`,
          tags: ["write"],
          result: own,
        },
        admin: { name: "admin-create", description: "For admins.", requiresApproval: false },
      },
    });

    expect(Object.keys(tools)).toEqual(["createProduct", "create_product", "admin-create"]);
    for (const tool of Object.values(tools)) {
      expect(tool).toBeInstanceOf(McpRouteDeclaration);
      expect(tool.method).toBe("POST");
      expect(tool.url).toBe("/:orgId/products");
    }
    expect(tools.createProduct.meta).toMatchObject({
      description: "Creates a product.",
      tags: ["products"],
      requiresApproval: true,
      params: { orgId: binder },
      files: { image: "input" },
      result,
    });
    expect(tools.create_product.meta).toMatchObject({
      description: "Creates a product. Name the org.",
      title: "Create a product",
      tags: ["write"],
      params: { orgId: "input" },
      result: own,
    });
    expect(tools["admin-create"].meta).toMatchObject({
      description: "For admins.",
      requiresApproval: false,
    });
    // Nothing of the expansion's own leaks into a declaration.
    for (const tool of Object.values(tools)) {
      expect(tool.meta).not.toHaveProperty("name");
      expect(tool.meta).not.toHaveProperty("casing");
      expect(tool.meta).not.toHaveProperty("audiences");
    }
  });

  test("params merge param by param, and declarations do not share the merged object", () => {
    const tools = router.fromApiRouteFor("GET", "/:orgId/orders/:orderId", {
      name: "show_order",
      description: "x",
      params: { orgId: binder, orderId: "input" },
      audiences: {
        agent: { casing: "camel" },
        remote: { casing: "snake", params: { orderId: binder } },
      },
    });

    expect(tools.showOrder.meta.params).toEqual({ orgId: binder, orderId: "input" });
    expect(tools.show_order.meta.params).toEqual({ orgId: binder, orderId: binder });
    expect(tools.showOrder.meta.params).not.toBe(tools.show_order.meta.params);
  });

  test("two audiences with one name fail at declaration", () => {
    expect(() =>
      router.fromApiRouteFor("GET", "/health", {
        name: "health",
        description: "x",
        audiences: { agent: {}, remote: { casing: "snake" } },
      }),
    ).toThrow(/the audiences "agent" and "remote" are both named "health"/);
  });

  test("an audience without a description, and no shared one, fails", () => {
    expect(() =>
      router.fromApiRouteFor("GET", "/health", {
        name: "health",
        audiences: { agent: { description: "Health" }, remote: { name: "remote-health" } },
      }),
    ).toThrow(/the audience "remote" has no description/);
    expect(() =>
      router.fromApiRouteFor("GET", "/health", {
        name: "health",
        audiences: { agent: { description: (shared: string) => shared } },
      }),
    ).toThrow(/the audience "agent" has no description/);
  });

  test("no audiences fails", () => {
    expect(() =>
      router.fromApiRouteFor("GET", "/health", { name: "health", description: "x", audiences: {} }),
    ).toThrow(/declare at least one audience/);
  });
});
