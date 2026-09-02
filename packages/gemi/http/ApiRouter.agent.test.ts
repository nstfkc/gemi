import { describe, expect, test } from "vitest";

import { AgentController } from "../ai/AgentController";
import { createFlatApiRoutes } from "../services/router/createFlatApiRoutes";
import { ApiRouter } from "./ApiRouter";
import { ResourceController } from "./Controller";

class ChatController extends AgentController {
  agent = { name: "stub", tools: [], provider: {} } as any;
}

describe("ApiRouter.agent()", () => {
  test("mounts four POST routes under one path", () => {
    class Api extends ApiRouter {
      routes = {
        "/chat": this.agent(ChatController),
      };
    }

    const flat = createFlatApiRoutes(new Api().routes);

    expect(Object.keys(flat).sort()).toEqual(
      ["/chat", "/chat/attach", "/chat/files", "/chat/stop"].sort(),
    );
    for (const path of ["/chat", "/chat/attach", "/chat/stop", "/chat/files"]) {
      expect(Object.keys(flat[path]!).sort()).toEqual(["OPTIONS", "POST"]);
    }
  });

  test("each path runs its own controller method", async () => {
    const called: string[] = [];

    class Recorder extends AgentController {
      agent = {} as any;
      async stream() {
        called.push("stream");
        return new Response(null);
      }
      async attach() {
        called.push("attach");
        return new Response(null);
      }
      async stop() {
        called.push("stop");
        return { stopped: true };
      }
      async upload() {
        called.push("upload");
        return { fileId: "f" };
      }
    }

    class Api extends ApiRouter {
      routes = { "/chat": this.agent(Recorder) };
    }

    const flat = createFlatApiRoutes(new Api().routes);
    await flat["/chat"]!.POST!.exec();
    await flat["/chat/attach"]!.POST!.exec();
    await flat["/chat/stop"]!.POST!.exec();
    await flat["/chat/files"]!.POST!.exec();

    expect(called).toEqual(["stream", "attach", "stop", "upload"]);
  });

  test("builds the controller per request, not once at mount", async () => {
    let constructed = 0;

    class Counting extends AgentController {
      agent = {} as any;
      readonly id: number;
      constructor() {
        super();
        this.id = ++constructed;
      }
      async stream() {
        return new Response(String(this.id));
      }
    }

    class Api extends ApiRouter {
      routes = { "/chat": this.agent(Counting) };
    }

    const flat = createFlatApiRoutes(new Api().routes);
    expect(constructed).toBe(0);

    expect(await (await flat["/chat"]!.POST!.exec()).text()).toBe("1");
    expect(await (await flat["/chat"]!.POST!.exec()).text()).toBe("2");
  });

  test("applies per-method middleware to that method only", () => {
    class Api extends ApiRouter {
      routes = {
        "/chat": this.agent(ChatController).middleware({
          stream: "auth",
          upload: ["auth", "rate-limit"],
        }),
      };
    }

    const flat = createFlatApiRoutes(new Api().routes);

    expect(flat["/chat"]!.POST!.middleware).toEqual(["auth"]);
    expect(flat["/chat/files"]!.POST!.middleware).toEqual(["auth", "rate-limit"]);
    // Not named in the config, so not guarded — the four are configured
    // separately precisely because they are not equally sensitive.
    expect(flat["/chat/attach"]!.POST!.middleware).toEqual([]);
    expect(flat["/chat/stop"]!.POST!.middleware).toEqual([]);
  });

  test("takes the prefix of the router it is mounted in", () => {
    class Nested extends ApiRouter {
      routes = {
        "/chat": this.agent(ChatController).middleware({ stop: "auth" }),
      };
    }
    class Api extends ApiRouter {
      routes = { "/ai": Nested };
    }

    const flat = createFlatApiRoutes(new Api().routes);

    expect(Object.keys(flat).sort()).toEqual(
      ["/ai/chat", "/ai/chat/attach", "/ai/chat/files", "/ai/chat/stop"].sort(),
    );
    expect(flat["/ai/chat/stop"]!.POST!.middleware).toEqual(["auth"]);
  });

  /**
   * The finding this test exists for: an agent used to come out unguarded here
   * while both of its siblings came out guarded, because an agent is flattened
   * as a nested router and `createFlatApiRoutes` replaces `rootMiddleware` when
   * it descends into one. `resource()` — the method the agent was told to work
   * like — concatenates. Same router, opposite result, and the one that lost is
   * the model endpoint that spends money.
   */
  test("inherits the enclosing router's middlewares, exactly as resource() does", () => {
    class Orders extends ResourceController {
      list() {
        return [];
      }
      store() {
        return {};
      }
      show() {
        return {};
      }
      update() {
        return {};
      }
      delete() {
        return {};
      }
    }

    class Api extends ApiRouter {
      middlewares = ["auth"];
      routes = {
        "/chat": this.agent(ChatController),
        "/orders/:id": this.resource(Orders),
        "/plain": this.get(() => ({ ok: true })),
      };
    }

    const flat = createFlatApiRoutes({ "/": Api });

    for (const path of ["/chat", "/chat/attach", "/chat/stop", "/chat/files"]) {
      expect(flat[path]!.POST!.middleware).toEqual(["auth"]);
    }
    expect(flat["/orders"]!.GET!.middleware).toEqual(["auth"]);
    expect(flat["/plain"]!.GET!.middleware).toEqual(["auth"]);
  });

  /**
   * Declaration order must not decide whether the agent is guarded. `routes`
   * and `middlewares` are both class fields, so writing `middlewares` below
   * `routes` means it is still `[]` when `this.agent()` runs — which is why the
   * router instance is captured and read at flatten time instead.
   */
  test("is guarded even when middlewares is declared after routes", () => {
    class Api extends ApiRouter {
      routes = {
        "/chat": this.agent(ChatController),
      };
      middlewares = ["auth"];
    }

    const flat = createFlatApiRoutes({ "/": Api });
    expect(flat["/chat"]!.POST!.middleware).toEqual(["auth"]);
  });

  test("puts the router's guards before the per-method ones", () => {
    class Api extends ApiRouter {
      middlewares = ["auth"];
      routes = {
        "/chat": this.agent(ChatController).middleware({ upload: "rate-limit" }),
      };
    }

    const flat = createFlatApiRoutes({ "/": Api });

    expect(flat["/chat/files"]!.POST!.middleware).toEqual(["auth", "rate-limit"]);
    expect(flat["/chat"]!.POST!.middleware).toEqual(["auth"]);
  });

  /**
   * A router nested inside another still replaces its parent's list rather than
   * concatenating — that predates this method and applies to every
   * `"/sub": SubRouter` in the framework. What matters for an agent is that it
   * lands on the same list its siblings inside `Nested` land on, which is
   * `Nested`'s.
   */
  test("takes the middlewares of the router it is written in, not the one above", () => {
    class Nested extends ApiRouter {
      middlewares = ["tenant"];
      routes = {
        "/chat": this.agent(ChatController),
        "/plain": this.get(() => ({ ok: true })),
      };
    }
    class Api extends ApiRouter {
      middlewares = ["auth"];
      routes = { "/ai": Nested };
    }

    const flat = createFlatApiRoutes({ "/": Api });

    expect(flat["/ai/chat"]!.POST!.middleware).toEqual(["tenant"]);
    expect(flat["/ai/plain"]!.GET!.middleware).toEqual(["tenant"]);
  });

  test("mounts alongside ordinary routes without disturbing them", () => {
    class Api extends ApiRouter {
      routes = {
        "/chat": this.agent(ChatController),
        "/health": this.get(() => ({ ok: true })),
      };
    }

    const flat = createFlatApiRoutes(new Api().routes);
    expect(Object.keys(flat["/health"]!).sort()).toEqual(["GET", "OPTIONS"]);
    expect(flat["/chat"]!.POST).toBeDefined();
  });
});
