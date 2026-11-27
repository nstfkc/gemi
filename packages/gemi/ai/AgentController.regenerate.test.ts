process.env.SECRET ??= "agent-controller-regenerate-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type { AgentStreamParams } from "./Agent";
import { AgentController, type AgentStore, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import { StubAgentRun } from "./store/stubAgentRun";
import type { AgentMessage } from "./types";

/**
 * #451: `regenerate` on a thread. The server owns a thread's history, so the
 * client trimming its copy changed nothing — the model read `user: X,
 * assistant: A, user: X` and wrote a follow-up. A turn sent with
 * `regenerate: true` now replaces the stored answer.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

const message = (
  id: string,
  role: AgentMessage["role"],
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
  ...extra,
});

function stubAgent() {
  const runs: StubAgentRun[] = [];
  const calls: AgentStreamParams[] = [];
  return {
    runs,
    calls,
    agent: {
      name: "stub",
      tools: [] as const,
      skills: [] as const,
      output: undefined,
      stream: (params: AgentStreamParams) => {
        calls.push(params);
        const run = new StubAgentRun(params.runId ?? `run_${runs.length}`);
        runs.push(run);
        return run;
      },
    } as any,
  };
}

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

async function setup(history: AgentMessage[], store: AgentStore = new MemoryAgentStore()) {
  const stub = stubAgent();
  const liveRuns = new MemoryLiveRuns();
  const { threadId } = await store.createThread({});
  await store.appendMessages(threadId, history);
  class Chat extends AgentController {
    agent = stub.agent;
    liveRuns = liveRuns;
    store = store;
  }
  return { ...stub, store, threadId, Chat };
}

const ids = (messages: AgentMessage[] | null) => (messages ?? []).map((m) => m.id);

describe("regenerate on a thread (#451)", () => {
  const history = () => [
    message("u0", "user", "first"),
    message("a0", "assistant", "first answer", { usage }),
    message("u1", "user", "second"),
    message("a1", "assistant", "old answer", { usage }),
  ];

  test("drops the last user turn and its answer, then runs that turn again", async () => {
    const { calls, runs, store, threadId, Chat } = await setup(history());

    const response = await new Chat().stream(
      // The client's copy of the turn is not what runs: the store's is.
      jsonRequest({ threadId, turn: { text: "stale client copy" }, regenerate: true }),
    );
    expect(response.status).toBe(200);

    expect(ids(calls[0]!.messages)).toEqual(["u0", "a0"]);
    expect(calls[0]!.turn).toEqual({ text: "second" });
    expect(ids(await store.loadThread(threadId))).toEqual(["u0", "a0"]);

    runs[0]!.finish({
      messages: [message("u2", "user", "second"), message("a2", "assistant", "new answer", { usage })],
    });
    await settle();

    const held = (await store.loadThread(threadId))!;
    expect(ids(held)).toEqual(["u0", "a0", "u2", "a2"]);
    // The replaced answer's usage left with it (#698): one answer per turn is
    // counted, not the old one and the new one.
    expect(held.filter((m) => m.usage).length).toBe(2);
  });

  test("without the flag the turn is still a follow-up", async () => {
    const { calls, Chat, threadId } = await setup(history());
    await new Chat().stream(jsonRequest({ threadId, text: "second" }));
    expect(ids(calls[0]!.messages)).toEqual(["u0", "a0", "u1", "a1"]);
  });

  test("steps over a file a tool showed, which is part of the answer", async () => {
    const shown: AgentMessage = {
      id: "shown_1",
      role: "user",
      content: [{ type: "file", fileId: "file_x", name: "chart.png", mimeType: "image/png" }],
      createdAt: new Date(0).toISOString(),
      finishReason: "stop",
    };
    const caller: AgentMessage = {
      id: "a1",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          name: "chart",
          input: {},
          attachments: [
            {
              attachment: { id: "att_1" },
              shown: { messageId: "shown_1", fileId: "file_x", createdAt: new Date(0).toISOString() },
            },
          ],
        } as any,
      ],
      createdAt: new Date(0).toISOString(),
      finishReason: "stop",
    };
    const { calls, store, threadId, Chat } = await setup([
      message("u0", "user", "draw it"),
      caller,
      shown,
      message("a2", "assistant", "here it is"),
    ]);

    await new Chat().stream(jsonRequest({ threadId, text: "draw it", regenerate: true }));

    expect(ids(calls[0]!.messages)).toEqual([]);
    expect(calls[0]!.turn).toEqual({ text: "draw it" });
    expect(ids(await store.loadThread(threadId))).toEqual([]);
  });

  test("a store without removeMessages answers 501 and is left alone", async () => {
    const inner = new MemoryAgentStore();
    const store: AgentStore = {
      createThread: (p) => inner.createThread(p),
      loadThread: (t) => inner.loadThread(t),
      appendMessages: (t, m) => inner.appendMessages(t, m),
    };
    const { calls, threadId, Chat } = await setup(history(), store);

    const response = await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true }));

    expect(response.status).toBe(501);
    expect((await response.json()).error.code).toBe("regenerate_unsupported");
    expect(calls).toHaveLength(0);
    expect(ids(await store.loadThread(threadId))).toEqual(["u0", "a0", "u1", "a1"]);
  });

  test("a thread with no user turn answers 409", async () => {
    const { calls, threadId, Chat } = await setup([]);
    const response = await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("nothing_to_regenerate");
    expect(calls).toHaveLength(0);
  });

  test("is not one of the app's body fields", async () => {
    const { calls, threadId, Chat } = await setup(history());
    await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true, pageId: 7 }));
    expect(calls[0]!.body).toEqual({ pageId: 7 });
  });

  test("is ignored without a thread: a stateless client trims its own history", async () => {
    const { calls, Chat } = await setup([]);
    const messages = [message("u0", "user", "first"), message("a0", "assistant", "a")];
    await new Chat().stream(jsonRequest({ messages, text: "again", regenerate: true }));
    expect(ids(calls[0]!.messages)).toEqual(["u0", "a0"]);
    expect(calls[0]!.turn).toEqual({ text: "again" });
  });

  test("a regenerate stopped before it starts puts the answer back", async () => {
    const { calls, store, threadId } = await setup(history());
    const stub = stubAgent();
    let chat!: AgentController;
    class Chat extends AgentController {
      agent = stub.agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
      protected async instructions() {
        // A stop landing while the turn waits, after the cut was made.
        await chat.stop(jsonRequest({ clientRunId: "c1" }));
        return "";
      }
    }
    chat = new Chat();

    const response = await chat.stream(
      jsonRequest({ threadId, text: "x", regenerate: true, clientRunId: "c1" }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("stopped");
    expect(calls).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
    expect(ids(await store.loadThread(threadId))).toEqual(["u0", "a0", "u1", "a1"]);
  });

  test("a regenerate whose hooks throw before the run puts the answer back", async () => {
    const { calls, store, threadId, agent } = await setup(history());
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
      protected async instructions(): Promise<string> {
        throw new Error("db down");
      }
    }
    await expect(
      new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true })),
    ).rejects.toThrow("db down");
    expect(calls).toHaveLength(0);
    expect(ids(await store.loadThread(threadId))).toEqual(["u0", "a0", "u1", "a1"]);
  });

  test("counts as the same conversation for maxConcurrentRuns (#444)", async () => {
    const { calls, runs, threadId, Chat } = await setup(history());
    class Limited extends Chat {
      protected maxConcurrentRuns = 1;
    }
    const as = (req: HttpRequest<any, any>) =>
      RequestContext.run(req as any, async () => {
        RequestContext.getStore().setUser({ id: 1 });
        return await new Limited().stream(req);
      });

    expect((await as(jsonRequest({ threadId, text: "more" }))).status).toBe(200);
    // The first run is still answering; regenerating on the same thread
    // supersedes it rather than being refused for a second slot.
    const pending = as(jsonRequest({ threadId, text: "more", regenerate: true }));
    await settle();
    expect(runs[0]!.stopped).toBe(true);
    // The stub does not end itself on stop; a real run does.
    runs[0]!.finish({ messages: [message("u2", "user", "more"), message("a2", "assistant", "x")] });
    const again = await pending;
    expect(again.status).toBe(200);
    // The superseded follow-up was the last user turn, so it is what is redone.
    expect(ids(calls[1]!.messages)).toEqual(["u0", "a0", "u1", "a1"]);
    runs[1]!.finish();
  });
});

describe("regenerate skips server events and keeps other turns (#1405)", () => {
  const event = (id: string, text: string): AgentMessage =>
    message(id, "user", text, { event: { name: "job-settled" }, turn: id });

  test("re-runs the last turn a person started, not a server event's", async () => {
    const { calls, store, threadId, Chat } = await setup([
      message("u0", "user", "first", { turn: "u0" }),
      message("a0", "assistant", "first answer", { turn: "u0" }),
      message("u1", "user", "second", { turn: "u1" }),
      message("a1", "assistant", "old answer", { turn: "u1" }),
      event("e1", "Job ended."),
      message("ae1", "assistant", "", { turn: "e1", finishReason: "error" }),
    ]);

    const response = await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true }));
    expect(response.status).toBe(200);

    // The event's text is not sent as the person's words.
    expect(calls[0]!.turn).toEqual({ text: "second" });
    // Only the regenerated turn left: the event and its reply stay.
    expect(ids(calls[0]!.messages)).toEqual(["u0", "a0", "e1", "ae1"]);
    const held = (await store.loadThread(threadId))!;
    expect(ids(held)).toEqual(["u0", "a0", "e1", "ae1"]);
    expect(held.find((m) => m.id === "e1")!.event).toEqual({ name: "job-settled" });
  });

  test("a thread whose only user turns are events answers 409 and is left alone", async () => {
    const { calls, store, threadId, Chat } = await setup([
      event("e1", "Job ended."),
      message("ae1", "assistant", "noted", { turn: "e1" }),
    ]);
    const response = await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("nothing_to_regenerate");
    expect(calls).toHaveLength(0);
    expect(ids(await store.loadThread(threadId))).toEqual(["e1", "ae1"]);
  });

  test("keeps another turn's messages stored after the regenerated one, answered calls included", async () => {
    const asked: AgentMessage = {
      id: "a1q",
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_q", name: "ask", input: {} } as any],
      createdAt: new Date(0).toISOString(),
      finishReason: "awaiting-input",
      turn: "u1",
    };
    const answered: AgentMessage = {
      ...asked,
      id: "a1ans",
      content: [
        { type: "tool-call", toolCallId: "call_q2", name: "ask", input: {} } as any,
        { type: "tool-result", toolCallId: "call_q2", name: "ask", output: "blue" } as any,
      ],
      finishReason: "stop",
    };
    const { calls, store, threadId, Chat } = await setup([
      message("u1", "user", "first", { turn: "u1" }),
      asked,
      // A parallel turn, started while turn u1 waited on its question.
      message("u2", "user", "second", { turn: "u2" }),
      // Turn u1's question answered, stored after u2.
      answered,
      message("a2", "assistant", "old answer", { turn: "u2" }),
    ]);

    await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true }));

    expect(calls[0]!.turn).toEqual({ text: "second" });
    expect(ids(calls[0]!.messages)).toEqual(["u1", "a1q", "a1ans"]);
    expect(ids(await store.loadThread(threadId))).toEqual(["u1", "a1q", "a1ans"]);
    // Other turns' open questions are not refused by the re-run.
    expect(calls[0]!.keepOtherTurnsOpen).toBe(true);
  });

  test("regenerates a turn with an event after it from the earlier user message", async () => {
    // Stored before gemi set `turn`: grouped by position, an event still
    // starts a turn of its own.
    const { calls, Chat, threadId } = await setup([
      message("u1", "user", "hello"),
      message("a1", "assistant", "hi"),
      message("e1", "user", "Job ended.", { event: { name: "job-settled" } }),
    ]);
    await new Chat().stream(jsonRequest({ threadId, text: "x", regenerate: true }));
    expect(calls[0]!.turn).toEqual({ text: "hello" });
    expect(ids(calls[0]!.messages)).toEqual(["e1"]);
  });
});
