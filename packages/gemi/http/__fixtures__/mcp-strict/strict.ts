/**
 * `fromApiRoute`'s `result` under `strict: true`, as an app compiles it (#769).
 * See `McpRouter.strict.test.ts`, which compiles this file and expects no
 * errors. Every `expectTypeOf` below is a case that broke under
 * `strictFunctionTypes`, where `data` was `unknown` for every route.
 */
import { expectTypeOf } from "vitest";

import { s } from "../../../ai/Schema";
import { ApiRouter, type CreateRPC } from "../../ApiRouter";
import { Controller, ResourceController } from "../../Controller";
import { HttpRequest } from "../../HttpRequest";
import { HttpResponse, httpError } from "../../HttpResponse";
import { McpRouter } from "../../McpRouter";

class RenameRequest extends HttpRequest<{ name: string }, { id: string }> {}

class ProductController extends Controller {
  // Sync controller method.
  rename(req = new RenameRequest()) {
    return { id: req.params.id, name: "renamed" };
  }
  // Async, answering through `HttpResponse.json`.
  async publish(req = new RenameRequest()) {
    return HttpResponse.json({ published: true, id: req.params.id });
  }
  // A typed error beside the success, so the RPC entry's `Error` is not `never`.
  async archive(req = new RenameRequest()) {
    if (req.params.id === "") return httpError(409, { message: "Already archived" });
    return { archived: true as const };
  }
}

class OrderController extends ResourceController {
  async list() {
    return [] as { id: string; total: number }[];
  }
  async store(_req: HttpRequest<{ sku: string }>) {
    return { id: "o1" };
  }
  async show() {
    return { id: "o1", total: 1 };
  }
  async update(_req: HttpRequest<{ total: number }>) {
    return { id: "o1", total: 2 };
  }
  async delete() {
    return { deleted: true };
  }
}

class Api extends ApiRouter {
  routes = {
    "/products/:id/name": this.put(ProductController, "rename"),
    "/products/:id/publish": this.post(ProductController, "publish"),
    "/products/:id/archive": this.post(ProductController, "archive"),
    "/orders/:orderId": this.resource(OrderController),
    // Inline handlers, sync and async.
    "/health": this.get(() => ({ ok: true })),
    "/stats": this.get(async () => ({ count: 3 })),
    "/ping": this.get(async () => HttpResponse.json({ pong: "yes" })),
  };
}

type Routes = CreateRPC<Api>;

export class Mcp extends McpRouter<Routes> {
  routes = {
    rename: this.fromApiRoute("PUT", "/products/:id/name", {
      description: "Rename",
      input: s.object({ name: s.string() }),
      params: { id: "input" },
      result: ({ id, name }) => {
        expectTypeOf(id).toEqualTypeOf<string>();
        expectTypeOf(name).toEqualTypeOf<string>();
        return name;
      },
    }),
    publish: this.fromApiRoute("POST", "/products/:id/publish", {
      description: "Publish",
      input: s.object({ name: s.string() }),
      params: { id: "input" },
      result: (data) => {
        expectTypeOf(data).toEqualTypeOf<{ published: boolean; id: string }>();
        return data.published;
      },
      output: s.boolean(),
    }),
    archive: this.fromApiRoute("POST", "/products/:id/archive", {
      description: "Archive",
      input: s.object({ name: s.string() }),
      params: { id: "input" },
      result: (data) => {
        expectTypeOf(data).toEqualTypeOf<{ archived: true }>();
        return data.archived;
      },
    }),
    orders: this.fromApiRoute("GET", "/orders", {
      description: "List orders",
      result: (orders) => {
        expectTypeOf(orders).toEqualTypeOf<{ id: string; total: number }[]>();
        return orders.map(({ id }) => id);
      },
      output: s.array(s.string()),
    }),
    order: this.fromApiRoute("GET", "/orders/:orderId", {
      description: "Show an order",
      params: { orderId: "input" },
      result: ({ total }) => total,
    }),
    createOrder: this.fromApiRoute("POST", "/orders", {
      description: "Create an order",
      input: s.object({ sku: s.string() }),
      result: ({ id }) => id,
    }),
    health: this.fromApiRoute("GET", "/health", {
      description: "Health",
      result: (data) => {
        expectTypeOf(data).toEqualTypeOf<{ ok: boolean }>();
        return data.ok;
      },
    }),
    stats: this.fromApiRoute("GET", "/stats", {
      description: "Stats",
      result: ({ count }) => count,
      output: s.number(),
    }),
    ping: this.fromApiRoute("GET", "/ping", {
      description: "Ping",
      result: ({ pong }) => pong,
    }),
    // `output` alone is checked against the answer too.
    healthOutput: this.fromApiRoute("GET", "/health", {
      description: "Health",
      output: s.object({ ok: s.boolean() }),
    }),
    // @ts-expect-error the route answers { ok: boolean }, not a `status` field
    healthWrongOutput: this.fromApiRoute("GET", "/health", {
      description: "Health",
      output: s.object({ status: s.string() }),
    }),
    // `input` is still checked against the body (`BodyOf`) under strict.
    renameWrongInput: this.fromApiRoute("PUT", "/products/:id/name", {
      description: "Rename",
      // @ts-expect-error the body's `name` is a string
      input: s.object({ name: s.number() }),
      params: { id: "input" },
    }),
    statsWrongResult: this.fromApiRoute("GET", "/stats", {
      description: "Stats",
      // @ts-expect-error result returns a number; output says string
      result: ({ count }) => count,
      output: s.string(),
    }),
  };
}
