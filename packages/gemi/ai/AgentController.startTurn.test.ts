process.env.SECRET ??= "agent-controller-start-turn-test-secret";

import { describe, expect, test } from "vitest";

import { InsufficientPermissionsError } from "../http/errors";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { Agent, AgentTool } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  AgentTurnError,
  type AuthorizeRequestParams,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import type { AgentMessage } from "./types";

/**
 * #839: a turn started by server code — a queue job, an MCP tool — with no
 * browser request behind it. It goes through the controller as a `useChat`
 * turn does, and is stored on the thread like one.
 */

const finish = (reason: "stop" = "stop"): ProviderEvent => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const textOf = (message: AgentMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

type PageBody = { pageId: string };

function setup(scripts: ProviderEvent[][] = [[{ type: "text-delta", delta: "done" }, finish()]]) {
  const store = new MemoryAgentStore();
  const liveRuns = new MemoryLiveRuns();
  const provider = fakeProvider(...scripts);
  const seen: {
    authorize: AuthorizeRequestParams<PageBody>[];
    authorizeUser: unknown[];
    instructions: PageBody[];
    toolContext: unknown[];
    toolBody: unknown[];
    hookUsers: unknown[];
    owners: (string | null)[];
  } = {
    authorize: [],
    authorizeUser: [],
    instructions: [],
    toolContext: [],
    toolBody: [],
    hookUsers: [],
    owners: [],
  };

  const editPage = AgentTool.create({
    name: "editPage",
    description: "Edit the page",
    inputSchema: s.object({ change: s.string() }),
    execute: async ({ change }, ctx) => {
      seen.toolContext.push(ctx.context);
      seen.toolBody.push(ctx.body);
      return { ok: true, change, threadId: ctx.threadId };
    },
  });

  const publish = AgentTool.create({
    name: "publish",
    description: "Publish the page",
    inputSchema: s.object({ pageId: s.string() }),
    requiresApproval: true,
    execute: async ({ pageId }) => ({ published: pageId }),
  });

  class PageChat extends AgentController<any, PageBody> {
    agent = Agent.create({
      name: "page-chat",
      provider,
      tools: [editPage, publish],
    }) as any;
    store = store;
    liveRuns = liveRuns;

    protected authorizeRequest(req: HttpRequest<any, any>, params: AuthorizeRequestParams<PageBody>) {
      seen.authorize.push(params);
      seen.authorizeUser.push(req.ctx()?.user ?? null);
      if ((this.constructor as typeof PageChat).refuseAll) {
        throw new InsufficientPermissionsError();
      }
    }

    static refuseAll = false;

    instructions(_req: HttpRequest<any, any>, { body }: { body: PageBody }) {
      seen.instructions.push(body);
      return `You edit page ${body.pageId}.`;
    }

    context(req: HttpRequest<any, any>) {
      return { userId: req.ctx()?.user?.id ?? null } as any;
    }

    protected async runOwner(req: HttpRequest<any, any>) {
      const owner = await super.runOwner(req);
      seen.owners.push(owner);
      return owner;
    }

    protected onStreamComplete(_: unknown, ctx: AgentHookContext) {
      seen.hookUsers.push(ctx.req.ctx()?.user ?? null);
    }
  }

  return { store, liveRuns, provider, seen, PageChat };
}

describe("AgentController.startTurn", () => {
  test("runs a turn on a thread from server code and stores it like a chat turn", async () => {
    const { store, PageChat } = setup();
    const { threadId } = await store.createThread({ userId: 1 });

    const turn = await PageChat.startTurn({
      threadId,
      text: "Make the hero darker",
      user: { id: 1 },
      body: { pageId: "p_1" },
    });
    expect(turn.runId).toMatch(/^run_/);
    expect(turn.threadId).toBe(threadId);

    const result = await turn.result();
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("done");
    expect(result.threadId).toBe(threadId);
    expect(result.pending).toEqual([]);
    // Memoized: the same answer however many times it is asked.
    expect(await turn.result()).toBe(result);

    const stored = (await store.loadThread(threadId))!;
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(textOf(stored[0])).toBe("Make the hero darker");
    expect(textOf(stored[1])).toBe("done");
    expect(stored[1].finishReason).toBe("stop");
  });

  test("the turn runs as the given user, with the given body, through the controller's own checks", async () => {
    const { store, seen, provider, PageChat } = setup([
      [
        {
          type: "tool-call",
          toolCallId: "c1",
          name: "editPage",
          args: '{"change":"darker hero"}',
        },
        finish(),
      ],
      [{ type: "text-delta", delta: "Edited." }, finish()],
    ]);
    const { threadId } = await store.createThread({ userId: 7 });

    const result = await (
      await PageChat.startTurn({
        threadId,
        text: "Darker hero",
        user: { id: 7 },
        body: { pageId: "p_7" },
      })
    ).result();

    expect(result.text).toBe("Edited.");
    expect(seen.authorize).toEqual([{ route: "stream", threadId, body: { pageId: "p_7" } }]);
    expect(seen.authorizeUser).toEqual([{ id: 7 }]);
    expect(seen.instructions).toEqual([{ pageId: "p_7" }]);
    expect(seen.owners).toEqual(["user:7"]);
    expect(seen.toolContext).toEqual([{ userId: 7 }]);
    expect(seen.toolBody).toEqual([{ pageId: "p_7" }]);
    expect(seen.hookUsers).toEqual([{ id: 7 }]);
    expect(provider.calls[0].systemPrompt).toContain("You edit page p_7.");

    const toolResult = result.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-result") as { output?: unknown } | undefined;
    expect(toolResult?.output).toEqual({ ok: true, change: "darker hero", threadId });
  });

  test("an anonymous turn when no user is given", async () => {
    const { store, seen, PageChat } = setup();
    const { threadId } = await store.createThread({});
    await (await PageChat.startTurn({ threadId, text: "hi", body: { pageId: "p" } })).result();
    expect(seen.authorizeUser).toEqual([null]);
    expect(seen.owners).toEqual([null]);
  });

  test("uses its own request scope, not the caller's request's", async () => {
    const { store, seen, PageChat } = setup();
    const { threadId } = await store.createThread({ userId: 2 });
    const outer = new HttpRequest(new Request("http://localhost/api/mcp", { method: "POST" }), {}, "api", "/mcp");

    const result = await RequestContext.run(
      outer,
      async () => {
        const turn = await PageChat.startTurn({
          threadId,
          text: "hi",
          user: { id: 2 },
          body: { pageId: "p" },
        });
        // The caller's request is not held open for the run.
        expect(RequestContext.getStore().hasPendingWork()).toBe(false);
        expect(RequestContext.getStore().user).toEqual({ id: 99 });
        return turn.result();
      },
      { user: { id: 99 } },
    );
    expect(result.finishReason).toBe("stop");
    expect(seen.authorizeUser).toEqual([{ id: 2 }]);
  });

  test("a turn the route would refuse throws AgentTurnError with its status and code", async () => {
    const { PageChat } = setup();
    const error = await PageChat.startTurn({
      threadId: "thread_missing",
      text: "hi",
      body: { pageId: "p" },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(AgentTurnError);
    expect(error).toMatchObject({ status: 404, code: "thread_not_found" });
    expect(error.message).toContain("thread_missing");
  });

  test("maxConcurrentRuns counts a server turn against its user", async () => {
    const { store, PageChat } = setup();
    class Limited extends PageChat {
      maxConcurrentRuns = 0;
    }
    const { threadId } = await store.createThread({ userId: 3 });
    const error = await Limited.startTurn({
      threadId,
      text: "hi",
      user: { id: 3 },
      body: { pageId: "p" },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(AgentTurnError);
    expect(error).toMatchObject({ status: 429, code: "too_many_runs", kind: "rate_limit" });
    expect(await store.loadThread(threadId)).toEqual([]);
  });

  test("a refusal from authorizeRequest is thrown as it is, before anything runs", async () => {
    const { store, provider, PageChat } = setup();
    class Refusing extends PageChat {
      static refuseAll = true;
    }
    const { threadId } = await store.createThread({});
    await expect(
      Refusing.startTurn({ threadId, text: "hi", body: { pageId: "p" } }),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    expect(provider.calls).toHaveLength(0);
    expect(await store.loadThread(threadId)).toEqual([]);
  });

  test("an approval is surfaced as pending, and can be answered with another server turn", async () => {
    const { store, PageChat } = setup([
      [
        { type: "tool-call", toolCallId: "c1", name: "publish", args: '{"pageId":"p_9"}' },
        finish(),
      ],
      [{ type: "text-delta", delta: "Published." }, finish()],
    ]);
    const { threadId } = await store.createThread({ userId: 9 });
    const user = { id: 9 };

    const first = await (
      await PageChat.startTurn({ threadId, text: "Publish it", user, body: { pageId: "p_9" } })
    ).result();
    expect(first.finishReason).toBe("awaiting-input");
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0]).toMatchObject({ toolCallId: "c1", name: "publish", kind: "approval" });

    const second = await (
      await PageChat.startTurn({
        threadId,
        user,
        body: { pageId: "p_9" },
        turn: {
          toolResults: [
            { toolCallId: "c1", signature: first.pending[0].signature, approve: true },
          ],
        },
      })
    ).result();
    expect(second.finishReason).toBe("stop");
    expect(second.text).toBe("Published.");

    const stored = (await store.loadThread(threadId))!;
    const published = stored
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-result") as { output?: unknown } | undefined;
    expect(published?.output).toEqual({ published: "p_9" });
  });

  test("stop() ends the run like the chat's stop button", async () => {
    const { store, provider, PageChat } = setup();
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
    const { threadId } = await store.createThread({});

    const turn = await PageChat.startTurn({ threadId, text: "hi", body: { pageId: "p" } });
    turn.stop({ reason: "job cancelled" });
    open();
    const result = await turn.result();
    expect(result.finishReason).toBe("aborted");
    const stored = (await store.loadThread(threadId))!;
    expect(stored.map((message) => message.role)).toContain("user");
  });

  test("needs a threadId", async () => {
    const { PageChat } = setup();
    await expect(
      PageChat.startTurn({ threadId: "", text: "hi", body: { pageId: "p" } }),
    ).rejects.toThrow(/threadId/);
  });
});

/**
 * #1178: `ifBusy` decides what a server turn does on a thread whose run is
 * still going. The default supersedes it, as a resend from the chat does.
 */
describe("AgentController.startTurn ifBusy", () => {
  /** Each model call waits for its own gate; `release(n)` opens the n-th. */
  function gated(scripts: ProviderEvent[][]) {
    const env = setup(scripts);
    const gates: { promise: Promise<void>; open: () => void }[] = [];
    const gateFor = (index: number) => {
      while (gates.length <= index) {
        let open!: () => void;
        const promise = new Promise<void>((resolve) => {
          open = resolve;
        });
        gates.push({ promise, open });
      }
      return gates[index]!;
    };
    const script = env.provider.stream.bind(env.provider);
    let calls = 0;
    env.provider.stream = (params) => {
      const index = calls++;
      return (async function* () {
        await gateFor(index).promise;
        yield* script(params);
      })();
    };
    return {
      ...env,
      release: (index: number) => gateFor(index).open(),
      calls: () => calls,
    };
  }

  const say = (text: string): ProviderEvent[] => [{ type: "text-delta", delta: text }, finish()];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const settled = <T>(promise: Promise<T>) => {
    const state = { done: false };
    promise.then(
      () => (state.done = true),
      () => (state.done = true),
    );
    return state;
  };

  test("queue: starts after the running turn has ended and sees its messages", async () => {
    const { store, provider, PageChat, release, calls } = gated([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await PageChat.startTurn({ threadId, text: "hi", body: { pageId: "p" } });

    const queued = PageChat.startTurn({
      threadId,
      text: "job done",
      body: { pageId: "p" },
      ifBusy: "queue",
    });
    const queuedState = settled(queued);
    await tick();
    expect(queuedState.done).toBe(false);
    expect(calls()).toBe(1);

    release(0);
    const firstResult = await first.result();
    expect(firstResult.finishReason).toBe("stop");
    expect(firstResult.text).toBe("first");

    const second = await queued;
    release(1);
    const secondResult = await second.result();
    expect(secondResult.text).toBe("second");
    // The queued turn's model call carries the first turn's answer.
    expect(provider.calls[1]!.messages.map((message) => textOf(message as AgentMessage))).toEqual([
      "hi",
      "first",
      "job done",
    ]);
  });

  test("queue: two queued turns run in the order they were queued", async () => {
    const { store, provider, PageChat, release } = gated([say("a"), say("b"), say("c")]);
    const { threadId } = await store.createThread({});
    const first = await PageChat.startTurn({ threadId, text: "1", body: { pageId: "p" } });
    const second = PageChat.startTurn({ threadId, text: "2", body: { pageId: "p" }, ifBusy: "queue" });
    const third = PageChat.startTurn({ threadId, text: "3", body: { pageId: "p" }, ifBusy: "queue" });

    release(0);
    await first.result();
    release(1);
    expect((await (await second).result()).finishReason).toBe("stop");
    release(2);
    expect((await (await third).result()).finishReason).toBe("stop");

    const stored = (await store.loadThread(threadId))!;
    expect(stored.map(textOf)).toEqual(["1", "a", "2", "b", "3", "c"]);
    expect(provider.calls).toHaveLength(3);
  });

  test("queue: a turn sent meanwhile still supersedes the running run, and the queued one waits for it", async () => {
    const { store, PageChat, release } = gated([say("first"), say("resent"), say("woken")]);
    const { threadId } = await store.createThread({});
    const first = await PageChat.startTurn({ threadId, text: "hi", body: { pageId: "p" } });
    const queued = PageChat.startTurn({
      threadId,
      text: "job done",
      body: { pageId: "p" },
      ifBusy: "queue",
    });
    await tick();

    // A person sends again: as from the chat, it stops the running run.
    const resent = await PageChat.startTurn({ threadId, text: "again", body: { pageId: "p" } });
    release(0);
    expect((await first.result()).finishReason).toBe("aborted");

    const queuedState = settled(queued);
    await tick();
    // The queued turn waits for the person's turn, not only the first.
    expect(queuedState.done).toBe(false);
    release(1);
    expect((await resent.result()).finishReason).toBe("stop");
    release(2);
    expect((await (await queued).result()).text).toBe("woken");

    const stored = (await store.loadThread(threadId))!;
    const texts = stored.map(textOf);
    expect(texts.indexOf("again")).toBeLessThan(texts.indexOf("job done"));
    expect(texts.at(-1)).toBe("woken");
  });

  test("skip: answers { skipped: true } on a busy thread and changes nothing", async () => {
    const { store, provider, PageChat, release } = gated([say("first"), say("later")]);
    const { threadId } = await store.createThread({});
    const first = await PageChat.startTurn({ threadId, text: "hi", body: { pageId: "p" } });

    const skipped = await PageChat.startTurn({
      threadId,
      text: "job done",
      body: { pageId: "p" },
      ifBusy: "skip",
    });
    expect(skipped).toEqual({ skipped: true, threadId });
    release(0);
    expect((await first.result()).finishReason).toBe("stop");
    expect(provider.calls).toHaveLength(1);
    expect((await store.loadThread(threadId))!.map(textOf)).toEqual(["hi", "first"]);

    // Once the thread is idle, a skip turn starts as usual.
    release(1);
    const later = await PageChat.startTurn({
      threadId,
      text: "now",
      body: { pageId: "p" },
      ifBusy: "skip",
    });
    expect("skipped" in later).toBe(false);
    if ("skipped" in later) return;
    expect((await later.result()).text).toBe("later");
  });

  test("supersede, the default, still stops the running turn", async () => {
    const { store, PageChat, release } = gated([say("first"), say("second")]);
    const { threadId } = await store.createThread({});
    const first = await PageChat.startTurn({ threadId, text: "hi", body: { pageId: "p" } });
    const second = await PageChat.startTurn({
      threadId,
      text: "again",
      body: { pageId: "p" },
      ifBusy: "supersede",
    });
    release(0);
    release(1);
    expect((await first.result()).finishReason).toBe("aborted");
    expect((await second.result()).text).toBe("second");
  });

  test("refuses an ifBusy it does not know", async () => {
    const { PageChat } = setup();
    await expect(
      PageChat.startTurn({ threadId: "t", body: { pageId: "p" }, ifBusy: "wait" as never }),
    ).rejects.toThrow(/ifBusy/);
  });
});

/** #1181: a turn that reports something that happened, not a person's message. */
describe("AgentController.startTurn event", () => {
  test("is stored as a user message with `event`, and the model reads it wrapped", async () => {
    const { store, provider, PageChat } = setup([
      [{ type: "text-delta", delta: "first" }, finish()],
      [{ type: "text-delta", delta: "noted" }, finish()],
      [{ type: "text-delta", delta: "later" }, finish()],
    ]);
    const { threadId } = await store.createThread({});
    await (await PageChat.startTurn({ threadId, text: "export it", body: { pageId: "p" } })).result();

    const turn = await PageChat.startTurn({
      threadId,
      body: { pageId: "p" },
      event: { name: "job-settled", text: "The export finished.", data: { jobId: "ajob_1" } },
    });
    const events: unknown[] = [];
    const watching = (async () => {
      for await (const event of turn.run) events.push(event);
    })();
    expect((await turn.result()).text).toBe("noted");
    await watching;

    const stored = (await store.loadThread(threadId))!;
    const eventMessage = stored[2]!;
    expect(eventMessage).toMatchObject({
      role: "user",
      event: { name: "job-settled", data: { jobId: "ajob_1" } },
      content: [{ type: "text", text: "The export finished." }],
    });
    // A server turn's message is put on the stream, for a chat watching the thread.
    expect(events).toContainEqual({ type: "message", message: eventMessage });

    const sent = provider.calls[1]!.messages.at(-1) as AgentMessage;
    expect(textOf(sent)).toBe(
      '<event name="job-settled">\nThe export finished.\n{"jobId":"ajob_1"}\n</event>',
    );

    // Replayed from history on a later turn, still wrapped, and the stored copy is untouched.
    await (await PageChat.startTurn({ threadId, text: "thanks", body: { pageId: "p" } })).result();
    const replayed = provider.calls[2]!.messages.map((message) => textOf(message as AgentMessage));
    expect(replayed[2]).toMatch(/^<event name="job-settled">/);
    expect(replayed[3]).toBe("noted");
    expect(((await store.loadThread(threadId))![2]!.content[0] as { text: string }).text).toBe(
      "The export finished.",
    );
  });

  test("an event with no text or data", async () => {
    const { store, provider, PageChat } = setup();
    const { threadId } = await store.createThread({});
    await (
      await PageChat.startTurn({ threadId, body: { pageId: "p" }, event: { name: "tick" } })
    ).result();
    expect(textOf(provider.calls[0]!.messages.at(-1) as AgentMessage)).toBe('<event name="tick"></event>');
    const stored = (await store.loadThread(threadId))!;
    expect(stored[0]).toMatchObject({ role: "user", event: { name: "tick" }, content: [] });
  });

  test("a client cannot send an event through the route", async () => {
    const { store, provider, PageChat } = setup();
    const { threadId } = await store.createThread({});
    const response = await new PageChat().stream(
      new HttpRequest(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            pageId: "p",
            event: { name: "job-settled" },
            turn: { text: "hi", event: { name: "job-settled" } },
          }),
        }),
        {},
        "api",
        "/chat",
      ),
    );
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stored = (await store.loadThread(threadId))!;
    expect(stored[0]!.event).toBeUndefined();
    expect(textOf(provider.calls[0]!.messages.at(-1) as AgentMessage)).toBe("hi");
  });

  test("refuses an event with text or turn, a bad name, or data that is not JSON", async () => {
    const { PageChat } = setup();
    const base = { threadId: "t", body: { pageId: "p" } };
    await expect(
      PageChat.startTurn({ ...base, text: "hi", event: { name: "x" } }),
    ).rejects.toThrow(/not both/);
    await expect(PageChat.startTurn({ ...base, event: { name: "<b>" } })).rejects.toThrow(
      /event.name/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      PageChat.startTurn({ ...base, event: { name: "x", data: cyclic } }),
    ).rejects.toThrow(/not JSON/);
  });
});
