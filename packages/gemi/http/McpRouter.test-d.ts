/**
 * Type-level tests for `fromApiRoute`.
 *
 * The point of declaring a model's reach by reference is that the reference is
 * checked: a renamed route, a wrong verb, a schema that drifted from the
 * handler, a path param nobody decided about, a file field nobody declared —
 * each of these must break the build, not the first `tools/call`. Every
 * `@ts-expect-error` below is one of those, and tsc fails on an unused one, so
 * a check that stops biting fails the typecheck too.
 *
 * Run with `bun run typecheck` (or `bun run test:types`).
 */
import { describe, expectTypeOf, test } from "vitest";

import { s } from "../ai/Schema";
import { ApiRouter, type CreateRPC } from "./ApiRouter";
import { Controller, ResourceController } from "./Controller";
import { HttpRequest } from "./HttpRequest";
import { McpRouteDeclaration, McpRouter } from "./McpRouter";

class CreateProductRequest extends HttpRequest<
  { name: string; price: number; image: File },
  { orgId: string }
> {}

class RenameRequest extends HttpRequest<{ name: string; note?: string }, {}> {}

class TouchRequest extends HttpRequest<{ note?: string }, {}> {}

class ProductController extends Controller {
  create(req = new CreateProductRequest()) {
    return { id: 1, orgId: req.params.orgId };
  }
  rename(req = new RenameRequest()) {
    return { ok: true };
  }
  touch(req = new TouchRequest()) {
    return { ok: true };
  }
}

class OrderController extends ResourceController {
  async list() {
    return [] as { id: string }[];
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

class OrgRouter extends ApiRouter {
  routes = {
    "/:orgId/products": this.post(ProductController, "create"),
    "/:orgId/orders/:orderId": this.resource(OrderController),
  };
}

class Api extends ApiRouter {
  routes = {
    "/org": OrgRouter,
    "/products/:id/name": this.put(ProductController, "rename"),
    "/products/:id/touch": this.patch(ProductController, "touch"),
    "/health": this.get(() => ({ ok: true })),
  };
}

type Routes = CreateRPC<Api>;

describe("fromApiRoute", () => {
  test("accepts a route exposed correctly", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        "create-product": this.fromApiRoute("POST", "/org/:orgId/products", {
          description: "Create a product",
          input: s.object({ name: s.string(), price: s.number() }),
          params: { orgId: () => "org_1" },
          files: { image: "input" },
        }),
        "rename-product": this.fromApiRoute("PUT", "/products/:id/name", {
          description: "Rename a product",
          // An optional body field may be left out of the schema.
          input: s.object({ name: s.string() }),
          params: { id: "input" },
        }),
        "list-orders": this.fromApiRoute("GET", "/org/:orgId/orders", {
          description: "List orders",
          params: { orgId: async () => "org_1" },
        }),
        "delete-order": this.fromApiRoute("DELETE", "/org/:orgId/orders/:orderId", {
          description: "Delete an order",
          params: { orgId: () => "org_1", orderId: "input" },
          requiresApproval: true,
        }),
        // A body whose fields are all optional, or that has none, needs no schema.
        "touch-product": this.fromApiRoute("PATCH", "/products/:id/touch", {
          description: "Touch a product",
          params: { id: "input" },
        }),
        health: this.fromApiRoute("GET", "/health", { description: "Health" }),
      };
    }
    expectTypeOf(new Mcp().routes["create-product"]).toEqualTypeOf<
      McpRouteDeclaration<"POST", "/org/:orgId/products">
    >();
  });

  test("an unknown or unmounted url is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        // @ts-expect-error a typo in the url
        a: this.fromApiRoute("POST", "/org/:orgId/prodcuts", { description: "x" }),
        // @ts-expect-error the path the router nests under is part of the url
        b: this.fromApiRoute("POST", "/:orgId/products", { description: "x" }),
      };
    }
  });

  test("a verb the route does not have is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        // @ts-expect-error DELETE lives on /org/:orgId/orders/:orderId, not on the collection
        a: this.fromApiRoute("DELETE", "/org/:orgId/orders", {
          description: "x",
          params: { orgId: "input" },
        }),
      };
    }
  });

  test("an input schema that does not match the body is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        wrongField: this.fromApiRoute("POST", "/org/:orgId/orders", {
          description: "x",
          // @ts-expect-error `title` is not the body; `sku` and `quantity` are
          input: s.object({ title: s.string() }),
          params: { orgId: "input" },
        }),
        wrongType: this.fromApiRoute("POST", "/org/:orgId/orders", {
          description: "x",
          // @ts-expect-error `quantity` is a number
          input: s.object({ sku: s.string(), quantity: s.string() }),
          params: { orgId: "input" },
        }),
        extraField: this.fromApiRoute("PUT", "/products/:id/name", {
          description: "x",
          // @ts-expect-error `title` is a field the route would never read
          input: s.object({ name: s.string(), title: s.string() }),
          params: { id: "input" },
        }),
        // @ts-expect-error `sku` and `quantity` are required, so a schema for them is too
        noInput: this.fromApiRoute("POST", "/org/:orgId/orders", {
          description: "x",
          params: { orgId: "input" },
        }),
        // @ts-expect-error the JSON half of this body still requires `name` and `price`
        noInputBesideFiles: this.fromApiRoute("POST", "/org/:orgId/products", {
          description: "x",
          params: { orgId: "input" },
          files: { image: "input" },
        }),
        optionalBodyExtraField: this.fromApiRoute("PATCH", "/products/:id/touch", {
          description: "x",
          // @ts-expect-error `title` is not a field of a body whose fields are all optional
          input: s.object({ title: s.string() }),
          params: { id: "input" },
        }),
        optionalBodyWrongType: this.fromApiRoute("PATCH", "/products/:id/touch", {
          description: "x",
          // @ts-expect-error `note` is a string
          input: s.object({ note: s.number() }),
          params: { id: "input" },
        }),
        binaryInInput: this.fromApiRoute("POST", "/org/:orgId/products", {
          description: "x",
          // @ts-expect-error the image is a file, declared in `files`, not a JSON field
          input: s.object({ name: s.string(), price: s.number(), image: s.string() }),
          params: { orgId: "input" },
          files: { image: "input" },
        }),
      };
    }
  });

  test("a path param that is neither bound nor input is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        // @ts-expect-error `params` is required: the url has an `:orgId`
        noParams: this.fromApiRoute("GET", "/org/:orgId/orders", { description: "x" }),
        missingOne: this.fromApiRoute("DELETE", "/org/:orgId/orders/:orderId", {
          description: "x",
          // @ts-expect-error `orderId` is decided by nobody
          params: { orgId: () => "org_1" },
        }),
        unknownOne: this.fromApiRoute("GET", "/org/:orgId/orders", {
          description: "x",
          // @ts-expect-error there is no `:tenant` in the url
          params: { orgId: "input", tenant: "input" },
        }),
      };
    }
  });

  test("a binary body field missing from files is an error", () => {
    class Mcp extends McpRouter<Routes> {
      routes = {
        // @ts-expect-error the body has an `image: File`, so `files` is required
        noFiles: this.fromApiRoute("POST", "/org/:orgId/products", {
          description: "x",
          input: s.object({ name: s.string(), price: s.number() }),
          params: { orgId: "input" },
        }),
        notBinary: this.fromApiRoute("POST", "/org/:orgId/products", {
          description: "x",
          input: s.object({ name: s.string(), price: s.number() }),
          params: { orgId: "input" },
          // @ts-expect-error `name` is not a file field
          files: { image: "input", name: "input" },
        }),
        filesOnJsonRoute: this.fromApiRoute("PUT", "/products/:id/name", {
          description: "x",
          input: s.object({ name: s.string() }),
          params: { id: "input" },
          // @ts-expect-error this route takes no files at all
          files: { image: "input" },
        }),
      };
    }
  });
});
