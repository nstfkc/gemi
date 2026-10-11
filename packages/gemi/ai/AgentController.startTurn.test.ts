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
