/**
 * Type-level tests for the RPC surface.
 *
 * `CreateRPC` is what gives an app's client typed, autocompleted calls against
 * its own API, and it is derived entirely through conditional types — so it can
 * silently stop matching a route without any runtime test noticing. These
 * assertions fail the build if that happens.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import {
  ApiRouter,
  type ApiRoutes,
  type CreateRPC,
  type FileHandler,
  type RouteHandler,
  type StreamHandler,
} from "./ApiRouter";
import { Controller } from "./Controller";
import type { HttpRequest } from "./HttpRequest";

class UserController extends Controller {
  show(req: HttpRequest<{ q: string }, { id: string }>) {
    return { id: req.params.id, name: "x" };
  }
}

class SubRouter extends ApiRouter {
  routes = {
    "/nested": this.get(() => ({ deep: 1 })),
  };
}

class Root extends ApiRouter {
  routes = {
    "/json": this.get(() => ({ ok: true })),
    "/created": this.post(() => ({ id: 1 })),
    "/replaced": this.put(() => ({ id: 1 })),
    "/patched": this.patch(() => ({ p: true })),
    "/gone": this.delete(() => ({ d: true })),
    "/ctrl/:id": this.get(UserController, "show"),
    "/guarded": this.get(() => ({ g: 1 })).middleware(["auth"]),
    "/download": this.file(() => null),
    "/video": this.stream(() => null),
    "/video-guarded": this.stream(() => null).middleware(["auth"]),
    "/sub": SubRouter,
  };
}

type RPC = CreateRPC<Root>;
type Keys = keyof RPC;

describe("CreateRPC", () => {
  test("includes every JSON verb", () => {
    expectTypeOf<"GET:/json">().toExtend<Keys>();
    expectTypeOf<"POST:/created">().toExtend<Keys>();
    expectTypeOf<"PUT:/replaced">().toExtend<Keys>();
    expectTypeOf<"PATCH:/patched">().toExtend<Keys>();
    expectTypeOf<"DELETE:/gone">().toExtend<Keys>();
  });

  test("includes controller-backed and middleware-wrapped routes", () => {
    expectTypeOf<"GET:/ctrl/:id">().toExtend<Keys>();
    // .middleware() returns `this`, so the generics must survive the chain.
    expectTypeOf<"GET:/guarded">().toExtend<Keys>();
  });

  test("prefixes routes from a nested router", () => {
    expectTypeOf<"GET:/sub/nested">().toExtend<Keys>();
  });

  test("preserves the handler's return type", () => {
    expectTypeOf<ReturnType<RPC["GET:/json"]>>().toEqualTypeOf<{ ok: boolean }>();
    expectTypeOf<ReturnType<RPC["GET:/sub/nested"]>>().toEqualTypeOf<{ deep: number }>();
  });

  test("preserves a controller's Input and Params", () => {
    expectTypeOf<Parameters<RPC["GET:/ctrl/:id"]>[0]>().toEqualTypeOf<
      HttpRequest<{ q: string }, { id: string }>
    >();
  });

  test("excludes byte-stream routes, which a JSON client cannot consume", () => {
    expectTypeOf<"GET:/download">().not.toExtend<Keys>();
    expectTypeOf<"GET:/video">().not.toExtend<Keys>();
    expectTypeOf<"GET:/video-guarded">().not.toExtend<Keys>();
  });
});

describe("ApiRoutes", () => {
  test("rejects values that are not route handlers", () => {
    // FileHandler and StreamHandler are deliberately near-empty so they stay
    // out of the RPC types. If either becomes structurally `{}`, every
    // non-nullish value satisfies it and a route can be assigned anything.
    expectTypeOf<42>().not.toExtend<ApiRoutes[string]>();
    expectTypeOf<"hello">().not.toExtend<ApiRoutes[string]>();
    expectTypeOf<{ nonsense: true }>().not.toExtend<ApiRoutes[string]>();
    expectTypeOf<() => void>().not.toExtend<ApiRoutes[string]>();
  });

  test("accepts every real handler form", () => {
    expectTypeOf<FileHandler>().toExtend<ApiRoutes[string]>();
    expectTypeOf<StreamHandler>().toExtend<ApiRoutes[string]>();
    expectTypeOf<RouteHandler<"GET", any, any, any>>().toExtend<ApiRoutes[string]>();
  });
});

describe("this.stream()", () => {
  test("accepts the documented FileStorage.read() shape and a Blob", () => {
    class R extends ApiRouter {
      routes = {
        "/a/:src*": this.stream(async (req: HttpRequest<any, { src: string }>) => {
          const src: string = req.params.src;
          return new Blob([src]);
        }),
        "/b": this.stream(() => null),
      };
    }
    expectTypeOf<R["routes"]>().toExtend<ApiRoutes>();
  });

  test("rejects a handler returning something that is not streamable", () => {
    class R extends ApiRouter {
      routes = {
        // @ts-expect-error - a plain JSON object is not a StreamOutput.
        // The directive itself is the assertion: if this stops erroring,
        // tsc reports an unused @ts-expect-error and the typecheck fails.
        "/bad": this.stream(async () => ({ json: true })),
      };
    }
    return R;
  });
});
