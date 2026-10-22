/**
 * Type-level tests for `fromApiRouteFor` (#1018): one route, one tool per
 * audience. Each audience must be checked exactly as the `fromApiRoute` call it
 * stands for, with the shared parts merged in, and the tool names must come
 * out as literals so the spread `routes` stays typed for `toAgentTools`.
 *
 * Run with `bun run typecheck` (or `bun run test:types`).
 */
import { describe, expectTypeOf, test } from "vitest";

import { s } from "../ai/Schema";
import { ApiRouter, type CreateRPC } from "./ApiRouter";
import { Controller, ResourceController } from "./Controller";
import { HttpRequest } from "./HttpRequest";
import type { McpCallContext } from "../services/mcp/McpRegistry";
import {
  McpRouteDeclaration,
  McpRouter,
  type McpCasedName,
  type McpParamBinder,
} from "./McpRouter";

class CreateProductRequest extends HttpRequest<
  { name: string; price: number; image: File },
  { orgId: string }
> {}

class RenameRequest extends HttpRequest<{ name: string; note?: string }, {}> {}

class ProductController extends Controller {
  create(req = new CreateProductRequest()) {
    return { id: 1, orgId: req.params.orgId };
  }
  rename(req = new RenameRequest()) {
    return { ok: true };
  }
}

class OrderController extends ResourceController {
  async list() {
    return [] as { id: string; total: number }[];
  }
  async store(req: HttpRequest<{ sku: string; quantity: number }>) {
    return { id: "o1" };
  }
  async show() {
    return { id: "o1" };
  }
  async update(req: HttpRequest<{ quantity: number }>) {
    return { id: "o1" };
  }
  async delete() {
    return { deleted: true };
  }
}

class Api extends ApiRouter {
  routes = {
    "/:orgId/products": this.post(ProductController, "create"),
    "/:orgId/orders/:orderId": this.resource(OrderController),
    "/products/:id/name": this.put(ProductController, "rename"),
    "/health": this.get(() => ({ ok: true })),
  };
}

type Routes = CreateRPC<Api>;

describe("McpCasedName", () => {
  test("splits at _, - and capitals, and joins in the casing asked for", () => {
    expectTypeOf<McpCasedName<"list_pages", "camel">>().toEqualTypeOf<"listPages">();
    expectTypeOf<McpCasedName<"listPages", "snake">>().toEqualTypeOf<"list_pages">();
    expectTypeOf<McpCasedName<"list-page-access", "camel">>().toEqualTypeOf<"listPageAccess">();
    expectTypeOf<McpCasedName<"readPageAccess", "kebab">>().toEqualTypeOf<"read-page-access">();
    expectTypeOf<McpCasedName<"health", "camel">>().toEqualTypeOf<"health">();
    expectTypeOf<McpCasedName<"get_v2_items", "camel">>().toEqualTypeOf<"getV2Items">();
  });
});

describe("fromApiRouteFor", () => {
  test("one declaration per audience, named by casing, name or the base name", () => {
    class Mcp extends McpRouter<Routes> {
      chatOrg: McpParamBinder = () => "org_chat";
      remoteOrg = this.param({ as: "org", input: s.string(), bind: (org) => org });

      routes = {
        ...this.fromApiRouteFor("GET", "/:orgId/orders", {
          name: "list_orders",
          description: "Lists the orders.",
          result: (orders) => orders.map(({ id }) => id),
          audiences: {
            agent: { casing: "camel", tags: ["orders"], params: { orgId: this.chatOrg } },
            remote: {
              title: "List orders",
              description: (shared) => `${shared} Name the org.`,
              tags: ["read"],
              params: { orgId: this.remoteOrg },
              result: (orders, call) => {
                expectTypeOf(orders).toEqualTypeOf<{ id: string; total: number }[]>();
                expectTypeOf(call).toEqualTypeOf<McpCallContext>();
                return { orders: orders.length };
              },
            },
            admin: { name: "orders-for-admins", params: { orgId: "input" } },
          },
        }),
      };
    }
    const routes = new Mcp().routes;
    expectTypeOf(routes.listOrders).toEqualTypeOf<
      McpRouteDeclaration<"GET", "/:orgId/orders", {}, string[], readonly ["orders"]>
    >();
    expectTypeOf(routes.list_orders).toEqualTypeOf<
      McpRouteDeclaration<
        "GET",
        "/:orgId/orders",
        { org: string },
        { orders: number },
        readonly ["read"]
      >
    >();
    expectTypeOf(routes["orders-for-admins"]).toEqualTypeOf<
      McpRouteDeclaration<"GET", "/:orgId/orders", { orgId: string }, string[], readonly []>
    >();
  });

  test("shared params, input, files, tags and output reach every audience", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        ...this.fromApiRouteFor("POST", "/:orgId/products", {
          name: "createProduct",
          description: "Create a product",
          input: s.object({ name: s.string(), price: s.number() }),
          params: { orgId: "input" },
          files: { image: "input" },
          tags: ["products"],
          output: s.object({ id: s.number() }),
          audiences: {
            agent: {},
            remote: {
              casing: "snake",
              files: { image: (ctx) => ctx.turn.attachments[0] },
              input: s.object({ name: s.string(), price: s.number().describe("In cents") }),
            },
          },
        }),
      };
    }
    const routes = new Mcp().routes;
    expectTypeOf(routes.createProduct).toEqualTypeOf<
      McpRouteDeclaration<
        "POST",
        "/:orgId/products",
        { name: string; price: number; orgId: string; image: string },
        { id: number },
        readonly ["products"]
      >
    >();
    // The bound file is not the model's to send.
    expectTypeOf(routes.create_product).toEqualTypeOf<
      McpRouteDeclaration<
        "POST",
        "/:orgId/products",
        { name: string; price: number; orgId: string },
        { id: number },
        readonly ["products"]
      >
    >();
  });

  test("an audience that leaves a path param to nobody is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        ...this.fromApiRouteFor("DELETE", "/:orgId/orders/:orderId", {
          name: "delete_order",
          description: "x",
          params: { orgId: () => "org_1" },
          audiences: {
            agent: { casing: "camel", params: { orderId: "input" } },
            // @ts-expect-error `orderId` is decided by nobody for this audience
            remote: { casing: "snake" },
          },
        }),
        ...this.fromApiRouteFor("GET", "/:orgId/orders", {
          name: "list_orders",
          description: "x",
          audiences: {
            // @ts-expect-error there is no `:tenant` in the url
            agent: { params: { orgId: "input", tenant: "input" } },
          },
        }),
        ...this.fromApiRouteFor("GET", "/:orgId/orders", {
          name: "list_orders",
          description: "x",
          // @ts-expect-error there is no `:tenant` in the url
          params: { orgId: "input", tenant: "input" },
          audiences: { agent: {} },
        }),
      };
    }
    void Mcp;
  });

  test("input is checked against the body, shared or the audience's", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        ...this.fromApiRouteFor("POST", "/:orgId/orders", {
          name: "create_order",
          description: "x",
          params: { orgId: "input" },
          audiences: {
            agent: { input: s.object({ sku: s.string(), quantity: s.number() }) },
            // @ts-expect-error `sku` and `quantity` are required, so a schema for them is too
            remote: { casing: "camel" },
            other: {
              name: "other",
              // @ts-expect-error `quantity` is a number
              input: s.object({ sku: s.string(), quantity: s.string() }),
            },
          },
        }),
        ...this.fromApiRouteFor("PUT", "/products/:id/name", {
          name: "rename",
          description: "x",
          // @ts-expect-error `title` is a field the route would never read
          input: s.object({ name: s.string(), title: s.string() }),
          params: { id: "input" },
          audiences: { agent: {} },
        }),
      };
    }
    void Mcp;
  });

  test("a binary field must be declared in files by every audience", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        ...this.fromApiRouteFor("POST", "/:orgId/products", {
          name: "create_product",
          description: "x",
          input: s.object({ name: s.string(), price: s.number() }),
          params: { orgId: "input" },
          audiences: {
            agent: { files: { image: "input" } },
            // @ts-expect-error the body has an `image: File`
            remote: { casing: "camel" },
          },
        }),
      };
    }
    void Mcp;
  });

  test("result and output are checked per audience", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        ...this.fromApiRouteFor("GET", "/:orgId/orders", {
          name: "list_orders",
          description: "x",
          params: { orgId: "input" },
          result: (orders) => orders.map(({ id }) => id),
          output: s.array(s.string()),
          audiences: {
            agent: {},
            // @ts-expect-error this audience's result returns numbers; the shared output says strings
            remote: { casing: "camel", result: (orders) => orders.map(({ total }) => total) },
            counted: {
              name: "count",
              result: (orders) => ({ count: orders.length }),
              output: s.object({ count: s.number() }),
            },
          },
        }),
        ...this.fromApiRouteFor("GET", "/:orgId/orders", {
          name: "first_order",
          description: "x",
          params: { orgId: "input" },
          // An audience's output that the shared result's return does not fit
          // fails on the audience, and leaves that return uninferred, which
          // tsc reports on the shared result too.
          // @ts-expect-error the shared result's return is left uninferred
          result: (orders) => orders[0].id,
          audiences: {
            // @ts-expect-error the shared result returns a string; this output says a number
            agent: { output: s.number() },
            remote: { name: "r" },
          },
        }),
        ...this.fromApiRouteFor("GET", "/health", {
          name: "health",
          description: "x",
          audiences: {
            // @ts-expect-error the route answers { ok: boolean }, not a `status` field
            agent: { output: s.object({ status: s.string() }) },
          },
        }),
      };
    }
    void Mcp;
  });

  test("every audience needs a description, its own or a shared one", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        ...this.fromApiRouteFor("GET", "/health", {
          name: "health",
          audiences: {
            agent: { description: "Health" },
            // @ts-expect-error no shared description, and none of its own
            remote: { casing: "kebab" },
            // @ts-expect-error a function needs a shared description to be handed
            other: { name: "other", description: (shared) => `${shared}!` },
          },
        }),
      };
    }
    void Mcp;
  });

  test("an unknown url or verb is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        // @ts-expect-error a typo in the url
        ...this.fromApiRouteFor("GET", "/:orgId/ordres", {
          name: "x",
          description: "x",
          audiences: { agent: {} },
        }),
      };
    }
    void Mcp;
  });
});
