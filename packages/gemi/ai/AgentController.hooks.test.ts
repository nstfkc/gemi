process.env.SECRET ??= "agent-controller-hooks-test-secret";

import { expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { InsufficientPermissionsError } from "../http/errors";
import { stateKey } from "../http/requestState";
import { Agent } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  defineAgentHooks,
  MemoryAgentStore,
  MemoryAttachmentStore,
  MemoryLiveRuns,
} from "./AgentController";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentRunResult } from "./types";

/**
 * #989: hooks shared by several controllers through `hooks`, without an
 * app-level base class between them and `AgentController`.
 */

type PageBody = { pageId: string };

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

function answering() {
  return fakeProvider([
    { type: "text-delta", delta: "hello" },
    {
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]);
}

function completion() {
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { finished, done };
}

const charge = stateKey<{ pageId: string; settled: boolean }>("charge");

test("controllers share one hooks object, and a turn's state passes between them", async () => {
  const settled: { controller: string; pageId: string; reply: string }[] = [];
  const authorized: string[] = [];
  const { finished, done } = completion();
  let completions = 0;

  const chatHooks = defineAgentHooks<PageBody>({
    authorizeRequest(_req, params) {
      authorized.push(`${params.route}:${params.body?.pageId}`);
    },
    context(req, { body }) {
      req.state.set(charge, { pageId: body.pageId, settled: false });
      return {};
    },
    onStreamComplete(result, ctx) {
      const turn = ctx.req.state.require(charge);
      turn.settled = true;
      settled.push({
        controller: ctx.req.rawRequest.headers.get("x-chat") ?? "",
        pageId: turn.pageId,
        reply: result.finishReason,
      });
      if (++completions === 2) done();
    },
  });

  const store = new MemoryAgentStore();
  class PageChat extends AgentController<any, PageBody & { focus?: string }> {
    agent = Agent.create({ name: "page", provider: answering() }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();
    hooks = chatHooks;
  }
  class PostChat extends AgentController<any, PageBody> {
    agent = Agent.create({ name: "post", provider: answering() }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();
    hooks = chatHooks;
  }

  const request = (chat: string, body: unknown) => {
    const req = jsonRequest(body);
    req.rawRequest.headers.set("x-chat", chat);
    return req;
  };
  const a = await store.createThread({});
  const b = await store.createThread({});
  await (
    await new PageChat().stream(
      request("page", { threadId: a.threadId, turn: { text: "hi" }, pageId: "p1" }),
    )
  ).text();
  await (
    await new PostChat().stream(
      request("post", { threadId: b.threadId, turn: { text: "hi" }, pageId: "p2" }),
    )
  ).text();
  await finished;

  expect(authorized).toEqual(["stream:p1", "stream:p2"]);
  expect(settled).toEqual([
    { controller: "page", pageId: "p1", reply: "stop" },
    { controller: "post", pageId: "p2", reply: "stop" },
  ]);
});

test("an authorizeRequest hook refuses the turn before the model is asked", async () => {
  let asked = 0;
  const provider = answering();
  const counting = {
    ...provider,
    stream: (...args: Parameters<typeof provider.stream>) => {
      asked++;
      return provider.stream(...args);
    },
  };
  const hooks = defineAgentHooks<PageBody>({
    authorizeRequest() {
      throw new InsufficientPermissionsError();
    },
  });
  class Chat extends AgentController<any, PageBody> {
    agent = Agent.create({ name: "chat", provider: counting as any }) as any;
    liveRuns = new MemoryLiveRuns();
    hooks = hooks;
  }

  await expect(
    new Chat().stream(jsonRequest({ messages: [], turn: { text: "hi" }, pageId: "p1" })),
  ).rejects.toBeInstanceOf(InsufficientPermissionsError);
  expect(asked).toBe(0);
});

test("the controller's own override wins over the hook, and super reaches the hook", async () => {
  const calls: string[] = [];
  const { finished, done } = completion();
  const hooks = defineAgentHooks<PageBody>({
    onStreamComplete() {
      calls.push("shared");
    },
    runOwner: () => "team:1",
  });
  const store = new MemoryAgentStore();
  class Chat extends AgentController<any, PageBody> {
    agent = Agent.create({ name: "chat", provider: answering() }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();
    hooks = hooks;

    protected runOwner() {
      return "user:override";
    }

    protected async onStreamComplete(result: AgentRunResult<any, any>, ctx: AgentHookContext) {
      await super.onStreamComplete(result, ctx);
      calls.push("own");
      done();
    }

    ownerOf() {
      return this.runOwner();
    }
  }

  const { threadId } = await store.createThread({});
  await (
    await new Chat().stream(jsonRequest({ threadId, turn: { text: "hi" }, pageId: "p1" }))
  ).text();
  await finished;

  expect(calls).toEqual(["shared", "own"]);
  expect(new Chat().ownerOf()).toBe("user:override");
});

test("without hooks, and for a hook left out, the method is gemi's default", async () => {
  const hooks = defineAgentHooks<PageBody>({ runOwner: () => "team:1" });
  class WithHooks extends AgentController<any, PageBody> {
    agent = {} as any;
    hooks = hooks;
    probe(req: HttpRequest<any, any>) {
      return {
        owner: this.runOwner(req),
        destination: this.attachmentDestination(new File(["x"], "x.txt"), req),
        limitKey: this.runLimitKey(req, { owner: "team:1" }),
      };
    }
  }
  class Plain extends AgentController<any, PageBody> {
    agent = {} as any;
    probe(req: HttpRequest<any, any>) {
      return { owner: this.runOwner(req), context: this.context(req, { body: { pageId: "p" } }) };
    }
  }

  const req = jsonRequest({});
  expect(new WithHooks().probe(req)).toEqual({
    owner: "team:1",
    destination: "both",
    limitKey: "team:1",
  });
  expect(new Plain().probe(req)).toEqual({ owner: null, context: {} });
});

test("an upload goes through the shared attachment hooks", async () => {
  const seen: unknown[] = [];
  const hooks = defineAgentHooks<PageBody>({
    attachmentScope: (_req, _threadId, extra) => ({ key: `page:${extra?.body.pageId}` }),
    checkUpload(file, _req, { body }) {
      seen.push({ file: file.name, pageId: body.pageId });
      if (file.size > 3) return { code: "storage_full", message: "Full." };
    },
    attachmentDestination: () => "storage",
  });
  class Chat extends AgentController<any, PageBody> {
    agent = { provider: {} } as any;
    liveRuns = new MemoryLiveRuns();
    attachments = new MemoryAttachmentStore();
    attachmentStorage = {
      put: async () => "stored",
      read: async () => {
        throw new Error("not read");
      },
    } as any;
    hooks = hooks;
  }
  const upload = (body: string) => {
    const form = new FormData();
    form.set("file", new File([body], "note.txt", { type: "text/plain" }));
    form.set("body", JSON.stringify({ pageId: "p1" }));
    return new HttpRequest(
      new Request("http://localhost/api/chat/files", { method: "POST", body: form }),
      {},
      "api",
      "/chat/files",
    );
  };

  const stored = await new Chat().upload(upload("hi"));
  expect(stored).toMatchObject({ destination: "storage", name: "note.txt" });
  expect(stored.attachmentId).toBeTruthy();

  const refused = await new Chat().upload(upload("too long")).catch((error: unknown) => error);
  expect((refused as any).payload.api).toEqual({
    status: 422,
    data: { error: { code: "storage_full", message: "Full." } },
  });
  expect(seen).toEqual([
    { file: "note.txt", pageId: "p1" },
    { file: "note.txt", pageId: "p1" },
  ]);
});

test("a prepareStep hook is called before each model call, as an override is", async () => {
  const steps: string[] = [];
  const { finished, done } = completion();
  const hooks = defineAgentHooks<PageBody>({
    prepareStep(step, ctx) {
      steps.push(`${ctx.threadId === undefined ? "stateless" : "thread"}:${step.step}`);
    },
    onStreamComplete: () => done(),
  });
  class Chat extends AgentController<any, PageBody> {
    agent = Agent.create({ name: "chat", provider: answering() }) as any;
    liveRuns = new MemoryLiveRuns();
    hooks = hooks;
  }

  await (
    await new Chat().stream(jsonRequest({ messages: [], turn: { text: "hi" }, pageId: "p1" }))
  ).text();
  await finished;

  expect(steps).toEqual(["stateless:1"]);
});

test("a reportHookFailure hook that throws falls back to the log", () => {
  const hooks = defineAgentHooks({
    reportHookFailure() {
      throw new Error("reporter down");
    },
  });
  class Chat extends AgentController {
    agent = {} as any;
    hooks = hooks;
    report(error: unknown) {
      this.reportHookFailure(error);
    }
  }
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    expect(() => new Chat().report(new Error("hook failed"))).not.toThrow();
  } finally {
    console.error = original;
  }
  expect(logged.map((args) => args[0])).toEqual([
    "[gemi/ai] reportHookFailure hook failed",
    "[gemi/ai] agent controller hook failed",
  ]);
});
