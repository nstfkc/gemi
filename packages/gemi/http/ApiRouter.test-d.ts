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
import { Agent, AgentTool, type ToolShapesOf } from "../ai/Agent";
import { AgentController } from "../ai/AgentController";
import { OpenAIProvider } from "../ai/AgentProvider";
import { s } from "../ai/Schema";
import { Storage } from "../facades/Storage";
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
    // #727: a read decorated in place, without unpacking it.
    "/report": this.stream(async () => ({
      ...(await Storage.read("k")),
      name: "report.pdf",
      download: true,
      headers: { "Cache-Control": "private" },
    })),
    "/sub": SubRouter,
    // #707: a stream or file `get` next to other verbs on one path.
    "/assets/:fileId": {
      get: this.stream(() => null),
      delete: this.delete(() => ({ deleted: true })),
    },
    "/reports/:id": {
      get: this.file(() => null).middleware(["auth"]),
      post: this.post(() => ({ created: 1 })),
      patch: this.patch(() => ({ patched: 1 })),
    },
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

describe("verb maps with a stream or file get (#707)", () => {
  test("keep their JSON verbs in the RPC types", () => {
    expectTypeOf<"DELETE:/assets/:fileId">().toExtend<Keys>();
    expectTypeOf<"POST:/reports/:id">().toExtend<Keys>();
    expectTypeOf<"PATCH:/reports/:id">().toExtend<Keys>();
    expectTypeOf<ReturnType<RPC["DELETE:/assets/:fileId"]>>().toEqualTypeOf<{
      deleted: boolean;
    }>();
    expectTypeOf<ReturnType<RPC["PATCH:/reports/:id"]>>().toEqualTypeOf<{ patched: number }>();
  });

  test("drop the byte GET, as a stream or file route on its own path is dropped", () => {
    expectTypeOf<"GET:/assets/:fileId">().not.toExtend<Keys>();
    expectTypeOf<"GET:/reports/:id">().not.toExtend<Keys>();
  });

  test("accept a controller-backed stream next to a controller-backed delete", () => {
    class AssetController extends Controller {
      file() {
        return new Blob(["x"]);
      }
      deleteFile() {
        return { ok: true };
      }
    }
    class R extends ApiRouter {
      routes = {
        "/pages/:pageId/assets/files/:fileId": {
          get: this.stream(AssetController, "file"),
          delete: this.delete(AssetController, "deleteFile"),
        },
      };
    }
    expectTypeOf<R["routes"]>().toExtend<ApiRoutes>();
    expectTypeOf<"DELETE:/pages/:pageId/assets/files/:fileId">().toExtend<keyof CreateRPC<R>>();
    expectTypeOf<"GET:/pages/:pageId/assets/files/:fileId">().not.toExtend<keyof CreateRPC<R>>();
  });

  test("still reject a stream or file under a verb other than get", () => {
    // Both are GET routes; only `get` takes them.
    expectTypeOf<{ delete: StreamHandler }>().not.toExtend<ApiRoutes[string]>();
    expectTypeOf<{ post: FileHandler }>().not.toExtend<ApiRoutes[string]>();
    expectTypeOf<{ get: StreamHandler; delete: RouteHandler<"DELETE", any, any, any> }>().toExtend<
      ApiRoutes[string]
    >();
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

// --- agent routes --------------------------------------------------------

const lookup = AgentTool.create({
  name: "lookup",
  description: "Look an order up",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ status: s.string() }),
  execute: async () => ({ status: "paid" }),
});

const supportAgent = Agent.create({
  name: "support",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [lookup],
});

class ChatController extends AgentController<typeof supportAgent> {
  agent = supportAgent;
}

class AgentRoot extends ApiRouter {
  routes = {
    "/chat": this.agent(ChatController),
    "/guarded-chat": this.agent(ChatController).middleware({ stream: "auth", stop: ["auth"] }),
    "/json": this.get(() => ({ ok: true })),
  };
}

type AgentRPC = CreateRPC<AgentRoot>;
type AgentKeys = keyof AgentRPC;

/**
 * An agent is one key, not four.
 *
 * `useChat("/chat")` reads `RPC` looking for `{ __agent: true }`, so the mounted
 * path has to be the key — and `/chat/attach`, `/chat/stop` and `/chat/files`
 * have to stay out of it. They are transport for the hook, not endpoints an app
 * calls, and a `POST:/chat/stop` in the RPC types would offer an app an
 * untyped, signature-less way to do what `stop()` already does.
 */
describe("CreateRPC for an agent route", () => {
  test("keys the route by its mounted path", () => {
    expectTypeOf<"/chat">().toExtend<AgentKeys>();
    expectTypeOf<"/guarded-chat">().toExtend<AgentKeys>();
  });

  test("marks it so useChat can pick it out of the same RPC interface", () => {
    expectTypeOf<AgentRPC["/chat"]["__agent"]>().toEqualTypeOf<true>();
  });

  test("carries the agent's tool shapes, not its tools", () => {
    expectTypeOf<AgentRPC["/chat"]["tools"]>().toEqualTypeOf<
      ToolShapesOf<typeof supportAgent.tools>
    >();
    expectTypeOf<AgentRPC["/chat"]["tools"]["lookup"]["input"]>().toEqualTypeOf<{
      orderId: string;
    }>();
    expectTypeOf<AgentRPC["/chat"]["tools"]["lookup"]["output"]>().toEqualTypeOf<{
      status: string;
    }>();
  });

  test("does not emit a key per sub-route", () => {
    expectTypeOf<"POST:/chat">().not.toExtend<AgentKeys>();
    expectTypeOf<"POST:/chat/attach">().not.toExtend<AgentKeys>();
    expectTypeOf<"POST:/chat/stop">().not.toExtend<AgentKeys>();
    expectTypeOf<"POST:/chat/files">().not.toExtend<AgentKeys>();
    expectTypeOf<"/chat/attach">().not.toExtend<AgentKeys>();
  });

  test("leaves the router's other routes alone", () => {
    expectTypeOf<"GET:/json">().toExtend<AgentKeys>();
  });

  test("survives .middleware(), which returns the route", () => {
    expectTypeOf<AgentRPC["/guarded-chat"]["tools"]>().toEqualTypeOf<
      ToolShapesOf<typeof supportAgent.tools>
    >();
  });
});
