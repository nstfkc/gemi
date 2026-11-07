process.env.SECRET ??= "agent-controller-store-scope-test-secret";

import { describe, expect, test } from "vitest";

import { ApiRouter } from "../http/ApiRouter";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { createFlatApiRoutes } from "../services/router/createFlatApiRoutes";
import { Agent } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { decodeSSE } from "./client/sse";
import type { AgentMessage } from "./types";

/**
 * #1177: `storeScope()` swaps the controller's `store` for a scoped view. The
 * view lives on the controller instance, so these check that no path hands one
 * instance to two requests, and that an instance reused across scopes is
 * refused rather than leaking its view.
 */

const say = (text: string): ProviderEvent[] => [
  { type: "text-delta", delta: text },
  { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
];

const textOf = (message: AgentMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

type OrgBody = { org?: string };

function setup(scripts: ProviderEvent[][]) {
  const store = new MemoryAgentStore();
  const liveRuns = new MemoryLiveRuns();
  const provider = fakeProvider(...scripts);
  const instances: { controller: object; scope: string | null }[] = [];
  const constructed: object[] = [];

  class Chat extends AgentController<any, OrgBody> {
    agent = Agent.create({ name: "chat", provider }) as any;
    store = store;
    liveRuns = liveRuns;
    constructor() {
      super();
      constructed.push(this);
    }
    protected storeScope(_req: HttpRequest<any, any>, { body }: { body: OrgBody }) {
      const scope = body.org ?? null;
      instances.push({ controller: this, scope });
      return scope;
    }
  }
  return { store, provider, instances, constructed, Chat };
}

const request = (body: Record<string, unknown>) =>
  new HttpRequest(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
    "api",
    "/chat",
  );

async function waitForLength(read: () => Promise<AgentMessage[] | null>, length: number) {
  let thread = await read();
  for (
    let i = 0;
    i < 200 && (thread?.length !== length || thread.at(-1)?.finishReason === undefined);
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    thread = await read();
  }
  return thread;
}

describe("AgentController.storeScope", () => {
  test("routed requests in two scopes each get a controller of their own", async () => {
    const { store, instances, Chat } = setup([say("for a"), say("for b")]);
    const a = await store.forScope("org-a").createThread({});
    const b = await store.forScope("org-b").createThread({});

    class Api extends ApiRouter {
      routes = { "/chat": this.agent(Chat) };
    }
    const flat = createFlatApiRoutes(new Api().routes);
    const route = (body: Record<string, unknown>) => {
      const req = request(body);
      return RequestContext.run(req, () => flat["/chat"]!.POST!.exec(req)) as Promise<Response>;
    };

    // Concurrently, so a shared instance would have both scopes at once.
    const [ra, rb] = await Promise.all([
      route({ threadId: a.threadId, text: "a", org: "org-a" }),
      route({ threadId: b.threadId, text: "b", org: "org-b" }),
    ]);
    await Promise.all([ra.text(), rb.text()]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    expect(instances).toHaveLength(2);
    expect(instances[0]!.controller).not.toBe(instances[1]!.controller);

    const threadA = await waitForLength(() => store.forScope("org-a").loadThread(a.threadId), 2);
    const threadB = await waitForLength(() => store.forScope("org-b").loadThread(b.threadId), 2);
    expect(threadA!.map(textOf)[0]).toBe("a");
    expect(threadB!.map(textOf)[0]).toBe("b");
    // Neither landed in the other's scope.
    expect(await store.forScope("org-a").loadThread(b.threadId)).toBeNull();
    expect(await store.forScope("org-b").loadThread(a.threadId)).toBeNull();
  });

  test("startTurn builds a controller per turn, and its scope stays with its turn", async () => {
    const { store, constructed, Chat } = setup([say("one"), say("two")]);
    const a = await store.forScope("org-a").createThread({});
    const b = await store.forScope("org-b").createThread({});

    const [ta, tb] = await Promise.all([
      Chat.startTurn({ threadId: a.threadId, text: "a", scope: "org-a" }),
      Chat.startTurn({ threadId: b.threadId, text: "b", body: { org: "org-b" } }),
    ]);
    await Promise.all([ta.result(), tb.result()]);

    expect(constructed).toHaveLength(2);
    expect(constructed[0]).not.toBe(constructed[1]);
    expect(await store.forScope("org-a").loadThread(a.threadId)).toHaveLength(2);
    expect(await store.forScope("org-b").loadThread(b.threadId)).toHaveLength(2);
    // An explicit scope wins over the body's.
    await expect(
      Chat.startTurn({ threadId: a.threadId, text: "x", scope: "org-b", body: { org: "org-a" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("a scoped startTurn with ifBusy queue waits for the running run, in the same scope", async () => {
    const { store, provider, Chat } = setup([say("first"), say("second")]);
    // The first model call waits until released, so the thread is busy.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const script = provider.stream.bind(provider);
    let calls = 0;
    provider.stream = (params) => {
      const index = calls++;
      return (async function* () {
        if (index === 0) await gate;
        yield* script(params);
      })();
    };

    const scoped = store.forScope("org-a");
    const { threadId } = await scoped.createThread({});
    const first = await Chat.startTurn({ threadId, text: "hi", scope: "org-a" });
    const queued = Chat.startTurn({ threadId, text: "job done", scope: "org-a", ifBusy: "queue" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);

    release();
    expect((await first.result()).text).toBe("first");
    const second = await queued;
    expect((await second.result()).text).toBe("second");

    // The queued turn saw the first turn's answer, read through the scope.
    expect(provider.calls[1]!.messages.map((m) => textOf(m as AgentMessage))).toEqual([
      "hi",
      "first",
      "job done",
    ]);
    expect((await scoped.loadThread(threadId))!.map(textOf)).toEqual([
      "hi",
      "first",
      "job done",
      "second",
    ]);
    // Nothing of it is visible from another scope.
    expect(await store.forScope("org-b").loadThread(threadId)).toBeNull();
  });

  test("an instance reused for a request in another scope is refused", async () => {
    const { store, Chat } = setup([say("one"), say("two"), say("three")]);
    const a = await store.forScope("org-a").createThread({});
    const b = await store.forScope("org-b").createThread({});
    const controller = new Chat();

    const first = await controller.stream(request({ threadId: a.threadId, text: "a", org: "org-a" }));
    await first.text();
    // Same scope again: fine.
    const again = await controller.stream(request({ threadId: a.threadId, text: "a2", org: "org-a" }));
    await again.text();
    // Another scope, or none, on the same instance: refused, not served from org-a's view.
    await expect(
      controller.stream(request({ threadId: b.threadId, text: "b", org: "org-b" })),
    ).rejects.toThrow(/another store scope/);
    await expect(controller.stream(request({ threadId: b.threadId, text: "b" }))).rejects.toThrow(
      /another store scope/,
    );
  });

  describe("attach, watch and event turns", () => {
    /** The scope from the signed-in user, as an app should: attach and watch carry no body. */
    function userScoped() {
      const store = new MemoryAgentStore();
      const liveRuns = new MemoryLiveRuns();
      const provider = fakeProvider(say("one"), say("two"));
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const script = provider.stream.bind(provider);
      provider.stream = (params) =>
        (async function* () {
          await gate;
          yield* script(params);
        })();
      class Chat extends AgentController<any> {
        agent = Agent.create({ name: "chat", provider }) as any;
        store = store;
        liveRuns = liveRuns;
        protected storeScope(req: HttpRequest<any, any>) {
          return (req.ctx?.()?.user as { org?: string } | null)?.org ?? null;
        }
      }
      const as = <T>(org: string, path: string, body: unknown, fn: (c: Chat, r: HttpRequest<any, any>) => Promise<T>) => {
        const req = new HttpRequest(
          new Request(`http://localhost/api/chat${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          {},
          "api",
          `/chat${path}`,
        );
        return RequestContext.run(req, () => fn(new Chat(), req), { user: { id: 1, org } });
      };
      return { store, Chat, open, as };
    }

    test("watch follows only threads in the caller's scope", async () => {
      const { store, Chat, open, as } = userScoped();
      const { threadId } = await store.forScope("org-a").createThread({ userId: 1 });

      const refused = await as("org-b", "/watch", { threadId }, (c, r) => c.watch(r));
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: "thread_not_found" } });

      const watching = await as("org-a", "/watch", { threadId }, (c, r) => c.watch(r));
      expect(watching.status).toBe(200);
      const reading = (async () => {
        for await (const frame of decodeSSE(watching.body)) {
          if (frame.event.type === "run-start") return frame.event.runId;
        }
      })();
      const turn = await Chat.startTurn({ threadId, text: "hi", user: { id: 1, org: "org-a" } });
      expect(await reading).toBe(turn.runId);
      open();
      await turn.result();
    });

    test("attach does not find a run on another scope's thread", async () => {
      const { store, Chat, open, as } = userScoped();
      const { threadId } = await store.forScope("org-a").createThread({ userId: 1 });
      const turn = await Chat.startTurn({ threadId, text: "hi", user: { id: 1, org: "org-a" } });

      const other = await as("org-b", "/attach", { threadId }, (c, r) => c.attach(r));
      expect(other.status).toBe(404);
      expect(await other.json()).toMatchObject({ error: { code: "no_live_run" } });

      const own = await as("org-a", "/attach", { threadId }, (c, r) => c.attach(r));
      expect(own.status).toBe(200);
      open();
      await own.text();
      await turn.result();
    });

    test("an event turn through a scoped store is stored in that scope", async () => {
      const { store, Chat, open } = userScoped();
      const { threadId } = await store.forScope("org-a").createThread({});
      open();
      const turn = await Chat.startTurn({
        threadId,
        scope: "org-a",
        event: { name: "job-settled", text: "The export finished." },
      });
      await turn.result();
      const stored = await store.forScope("org-a").loadThread(threadId);
      expect(stored![0]).toMatchObject({ role: "user", event: { name: "job-settled" } });
      expect(await store.forScope("org-b").loadThread(threadId)).toBeNull();
    });
  });
});
