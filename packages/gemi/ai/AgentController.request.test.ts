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
import { Agent, AgentTool } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import { StubAgentRun } from "./store/stubAgentRun";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

/**
 * The controller's own hooks, driven through a real request to an agent route
 * behind `auth`. They run after the run has settled — which is when the
 * request would otherwise end and take the user with it — and they are where
 * an app writes a message under the user who sent it.
 */

// Far from both ends, so `getSession` neither expires nor slides it.
const LIVE = {
  expiresAt: new Date(Date.now() + 365 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 365 * 86_400_000),
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    return args.token === "v2.tok-alice"
      ? ({ token: args.token, ...LIVE, user: { id: 1, name: "alice" } } as any)
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
/** Held by a test, to keep `onError` from settling until it says so. */
let errorGate: Promise<void> | null = null;

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
    if (errorGate) await errorGate;
    log.push(`error:${userOf(ctx)}`);
  }

  protected async onStreamComplete(_: unknown, ctx: AgentHookContext) {
    await tick();
    log.push(`complete:${userOf(ctx)}`);
  }
}

const refundOrder = AgentTool.create({
  name: "refundOrder",
  description: "Refund an order",
  inputSchema: s.object({ orderId: s.string() }),
  outputSchema: s.object({ refundId: s.string() }),
  requiresApproval: true,
  execute: async ({ orderId }) => ({ refundId: `rf_${orderId}` }),
});

/** A run that parks on an approval, with an audit write in front of it. */
class Refunds extends AgentController {
  agent = Agent.create({
    name: "refunds",
    provider: fakeProvider([
      { type: "tool-call", toolCallId: "c1", name: "refundOrder", args: '{"orderId":"ord_1"}' },
      finish(),
    ]),
    tools: [refundOrder],
  }) as any;
  liveRuns = liveRuns;
  hookHoldMs = holdMs;

  protected async onToolCall(_: unknown, ctx: AgentHookContext) {
    // Slower than the run and every hook after it: the next frame's hook is
    // queued behind this one, and is not called until it is done.
    await new Promise((resolve) => setTimeout(resolve, 60));
    log.push(`toolcall:${userOf(ctx)}`);
  }

  protected async onAwaitingInput(pending: PendingToolCall[], ctx: AgentHookContext) {
    log.push(`awaiting:${pending.length}:${userOf(ctx)}`);
  }
}

/** A run whose `result()` rejects: the one `onError` not off the event stream. */
class Broken extends AgentController {
  agent = {
    name: "broken",
    tools: [] as const,
    skills: [] as const,
    output: undefined,
    provider: {},
    stream: () => {
      const run = new StubAgentRun("run_broken");
      run.result = () => Promise.reject(new Error("store unreachable"));
      // A stub that never emitted reads from a cursor it never reaches, and
      // its frames would not end.
      run.emit({ type: "run-start", runId: run.runId } as AgentStreamEvent);
      run.finish();
      return run;
    },
  } as any;
  liveRuns = liveRuns;
  hookHoldMs = holdMs;

  protected async onError(error: { message: string }, ctx: AgentHookContext) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    log.push(`error:${error.message}:${userOf(ctx)}`);
  }
}

class Api extends ApiRouter {
  routes = {
    "/chat": this.agent(Chat).middleware({ stream: "auth" }),
    "/refunds": this.agent(Refunds).middleware({ stream: "auth" }),
    "/broken": this.agent(Broken).middleware({ stream: "auth" }),
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

function send(body: Record<string, unknown>, path = "/api/chat") {
  return app.fetch(
    new Request(`http://gemi.dev${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "access_token=v2.tok-alice" },
      body: JSON.stringify(body),
    }),
  );
}

async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await tick();
  expect(done()).toBe(true);
}

const ends = () => log.filter((entry) => entry.startsWith("end:"));

/**
 * `hookHoldMs` for the tests that are about the bound itself. No other timer
 * in this file, or on the request path, uses it.
 */
const HOLD_MS = 4_321;

/**
 * The `hookHoldMs` bound, on a clock the test turns by hand.
 *
 * Only the timer the controller arms for the bound is taken over: `setTimeout`
 * with exactly `HOLD_MS`. Every other timer — `tick`, the request plumbing —
 * runs on the real clock as before. With a real 30ms bound these tests raced
 * three 5ms hook timers against it, and a runner that stalled the event loop
 * for 30ms ended the request between two hooks (#649). Here the bound lapses
 * when, and only when, the test calls `lapse()`, so how long the hooks take in
 * wall-clock time no longer matters.
 */
function holdClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Map<object, () => void>();

  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms !== HOLD_MS) return realSetTimeout(fn, ms, ...args);
    const handle = {};
    pending.set(handle, () => fn(...args));
    return handle;
  }) as typeof setTimeout);

  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: unknown) => {
    if (handle && pending.delete(handle as object)) return;
    realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout);

  return {
    /** Bounds armed and not yet cleared or lapsed. */
    get armed() {
      return pending.size;
    },
    /** `hookHoldMs` passes for every bound armed so far. */
    lapse() {
      const due = [...pending.values()];
      pending.clear();
      for (const fire of due) fire();
    },
  };
}

beforeEach(() => {
  log = [];
  messageGate = null;
  modelGate = null;
  holdMs = 30_000;
  modelFails = false;
  errorGate = null;
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
    let release!: () => void;
    errorGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await (await send({ text: "hi" })).text();
    // Every hook after the run is done, and `onError` is not: the request is
    // still open for it. Held by a gate rather than a longer timer, which a
    // stalled event loop could fire before the hooks' own.
    await until(() => log.includes("complete:1"));
    await tick();
    expect(ends()).toEqual([]);

    release();
    await until(() => ends().length > 0);
    await tick();

    // `onError` fires off the event stream, not after the run, and here it is
    // the last hook to finish: the request waits for it all the same.
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
    holdMs = HOLD_MS;
    const hold = holdClock();
    messageGate = new Promise<void>(() => {});

    await (await send({ text: "hi" })).text();
    // The run has settled and the bound is running, and the hook never will:
    // nothing but the bound can end the request now.
    await until(() => hold.armed === 1);
    await tick();
    expect(ends()).toEqual([]);

    hold.lapse();
    await until(() => ends().length === 1);
    expect(log).toEqual(["end:/api/chat"]);
  });

  test("a run longer than hookHoldMs is not a hung hook: the bound starts once it settles", async () => {
    holdMs = HOLD_MS;
    const hold = holdClock();
    let open!: () => void;
    modelGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const res = await send({ text: "hi" });
    await tick();
    // The run is still going, and has now outlasted `hookHoldMs`: a bound that
    // started with it would lapse here, and end the request before the hooks.
    hold.lapse();
    expect(ends()).toEqual([]);

    open();
    await res.text();
    await until(() => ends().length > 0);
    await tick();

    // The bound armed once the run settled never lapses, so the hooks take
    // however long they take.
    expect(log).toEqual(["message:user:1", "message:assistant:1", "complete:1", "end:/api/chat"]);
  });

  test("hookHoldMs = Infinity holds the request until the hooks are done", async () => {
    // `setTimeout` fires a delay it cannot hold after ~1ms, which would end the
    // request at once: the opposite of what raising the bound asked for.
    holdMs = Infinity;
    let release!: () => void;
    messageGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await (await send({ text: "hi" })).text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ends()).toEqual([]);

    release();
    await until(() => ends().length > 0);
    await tick();
    expect(log).toEqual(["message:user:1", "message:assistant:1", "complete:1", "end:/api/chat"]);
  });

  test("an event hook queued behind a slower one still sees the user, and onRequestEnd waits for it", async () => {
    await (await send({ text: "refund ord_1" }, "/api/refunds")).text();
    await until(() => ends().length > 0);
    await tick();

    // `onAwaitingInput` is where an approver is notified, and it is not called
    // until the audit write in `onToolCall` is done — by which time the run,
    // and every hook after it, has long settled.
    expect(log).toEqual(["toolcall:1", "awaiting:1:1", "end:/api/refunds"]);
  });

  test("an onError for a run whose result rejects sees the user, and onRequestEnd runs after it", async () => {
    await (await send({ text: "hi" }, "/api/broken")).text();
    await until(() => ends().length > 0);
    await tick();

    expect(log).toEqual(["error:store unreachable:1", "end:/api/broken"]);
  });
});
