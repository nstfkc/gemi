process.env.SECRET ??= "agent-controller-request-test-secret";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { AuthManager } from "../auth/AuthManager";
import { UserProvider } from "../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../auth/types";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { AuthenticationMiddleware } from "../http/AuthenticationMiddlware";
import type { HttpRequest } from "../http/HttpRequest";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { ServiceProvider } from "../support/ServiceProvider";
import { Agent } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentMessage } from "./types";

/**
 * The controller's own hooks, driven through a real request to an agent route
 * behind `auth`. They run after the run has settled — which is when the
 * request would otherwise end and take the user with it — and they are where
 * an app writes a message under the user who sent it.
 */

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    return args.token === "tok-alice"
      ? ({ token: args.token, user: { id: 1, name: "alice" } } as any)
      : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Every hook and every request end, in the order they happened. */
let log: string[] = [];
/** Held by a test, to keep `onMessage` from settling until it says so. */
let messageGate: Promise<void> | null = null;
/** Held by a test, to keep the model from answering until it says so. */
let modelGate: Promise<void> | null = null;
let holdMs = 30_000;
/** Set by a test whose model call fails outright. */
let modelFails = false;

const threads = new MemoryAgentStore();
const liveRuns = new MemoryLiveRuns();

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

function gatedProvider() {
  const provider = fakeProvider([{ type: "text-delta", delta: "hello" }, finish()]);
  const script = provider.stream.bind(provider);
  provider.stream = (params) =>
    (async function* () {
      if (modelGate) await modelGate;
      if (modelFails) throw new Error("model unavailable");
      yield* script(params);
    })();
  return provider;
}

const userOf = (ctx: AgentHookContext) => ctx.req.ctx()?.user?.id ?? null;

class Chat extends AgentController {
  agent = Agent.create({ name: "chat", provider: gatedProvider() }) as any;
  store = threads;
  liveRuns = liveRuns;
  hookHoldMs = holdMs;

  protected async onMessage(message: AgentMessage, ctx: AgentHookContext) {
    const gate = messageGate;
    // After an await, as a database write is.
    await tick();
    if (gate) await gate;
    log.push(`message:${message.role}:${userOf(ctx)}`);
  }

  protected async onError(_: unknown, ctx: AgentHookContext) {
    // Slower than the hooks after the run put together.
    await new Promise((resolve) => setTimeout(resolve, 50));
    log.push(`error:${userOf(ctx)}`);
  }

  protected async onStreamComplete(_: unknown, ctx: AgentHookContext) {
    await tick();
    log.push(`complete:${userOf(ctx)}`);
  }
}

class Api extends ApiRouter {
  routes = {
    "/chat": this.agent(Chat).middleware({ stream: "auth" }),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware } },
    route: {
      api: {
        rootRouter: Api,
        onRequestEnd: (req: HttpRequest) => {
          log.push(`end:${new URL(req.rawRequest.url).pathname}`);
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

function send(body: Record<string, unknown>) {
  return app.fetch(
    new Request("http://gemi.dev/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "access_token=tok-alice" },
      body: JSON.stringify(body),
    }),
  );
}

async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await tick();
  expect(done()).toBe(true);
}

const ends = () => log.filter((entry) => entry.startsWith("end:"));

beforeEach(() => {
  log = [];
  messageGate = null;
  modelGate = null;
  holdMs = 30_000;
  modelFails = false;
  liveRuns.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentController hooks, inside the request that started the run", () => {
  test("onMessage and onStreamComplete see the user who started the run, and onRequestEnd runs after them, once", async () => {
    const res = await send({ text: "hi" });
    await res.text();
    await until(() => ends().length > 0);
    await tick();

    expect(log).toEqual(["message:user:1", "message:assistant:1", "complete:1", "end:/api/chat"]);
  });

  test("a client that cancels mid-run does not take the user from them", async () => {
    let open!: () => void;
    modelGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const res = await send({ text: "hi" });
    await res.body!.cancel();
    await tick();
    // The body is gone and the run is not: the request is still open.
    expect(log).toEqual([]);

    open();
    await until(() => ends().length > 0);
    await tick();

    expect(log).toEqual(["message:user:1", "message:assistant:1", "complete:1", "end:/api/chat"]);
  });

  test("an onError for a failed run sees the user, even when it outlasts the hooks after the run", async () => {
    modelFails = true;

    await (await send({ text: "hi" })).text();
    await until(() => ends().length > 0);
    await tick();

    // `onError` fires off the event stream, not after the run, and here it is
    // the last hook to finish: the request waits for it by itself.
    expect(log).toEqual([
      "message:user:1",
      "message:assistant:1",
      "complete:1",
      "error:1",
      "end:/api/chat",
    ]);
  });

  test("a slow onMessage holds its own request, not the next turn on the thread", async () => {
    const { threadId } = await threads.createThread({});
    let release!: () => void;
    messageGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await (await send({ threadId, text: "one" })).text();
    messageGate = null;
    await tick();

    // The first turn's hooks are stuck, so its request is still open...
    expect(ends()).toEqual([]);

    // ...and the next turn runs to the end regardless, with the first answer
    // already in its history.
    await (await send({ threadId, text: "two" })).text();
    await until(() => ends().length === 1);
    expect((await threads.loadThread(threadId))!.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    release();
    await until(() => ends().length === 2);
    await tick();
    expect(log.filter((entry) => entry.startsWith("complete:"))).toEqual([
      "complete:1",
      "complete:1",
    ]);
  });

  test("a hook that never settles holds the request for hookHoldMs, and no longer", async () => {
    holdMs = 30;
    messageGate = new Promise<void>(() => {});

    await (await send({ text: "hi" })).text();
    await tick();
    expect(ends()).toEqual([]);

    await until(() => ends().length === 1);
    expect(log).toEqual(["end:/api/chat"]);
  });
});
