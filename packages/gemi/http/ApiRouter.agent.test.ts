import { describe, expect, test } from "vitest";

import { AgentController } from "../ai/AgentController";
import { createFlatApiRoutes } from "../services/router/createFlatApiRoutes";
import { ApiRouter } from "./ApiRouter";

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
   * An agent route is flattened as a nested router, so it inherits the
   * enclosing router's `middlewares` exactly as a nested router does — which is
   * to say not at all: `createFlatApiRoutes` replaces `rootMiddleware` when it
   * descends into a router instead of concatenating. That predates this method
   * and applies to every `"/sub": SubRouter` in the framework.
   *
   * It is asserted here rather than left implicit because the consequence is
   * sharper for an agent than for a sub-router: `middlewares = ["auth"]` on the
   * router guards `this.post(...)` next door and does not guard the agent. Use
   * `.middleware({ stream, attach, stop, upload })`, which is what the four
   * names are for.
   */
  test("does NOT inherit the enclosing router's middlewares, as nested routers do not", () => {
    class Api extends ApiRouter {
      middlewares = ["auth"];
      routes = {
        "/chat": this.agent(ChatController),
        "/plain": this.get(() => ({ ok: true })),
      };
    }

    const flat = createFlatApiRoutes({ "/": Api });

    expect(flat["/chat"]!.POST!.middleware).toEqual([]);
    expect(flat["/plain"]!.GET!.middleware).toEqual(["auth"]);
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
