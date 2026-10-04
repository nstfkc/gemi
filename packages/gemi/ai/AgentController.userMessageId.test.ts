process.env.SECRET ??= "agent-controller-user-message-id-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { applyFrame, initialChatState } from "./client/reducer";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentMessage, AgentStreamFrame } from "./types";

/**
 * #466: the user's own message is minted on the server (`msg_<uuid>`) and was
 * reported to the store only, so the client kept its optimistic `local_<uuid>`
 * copy for good. After a reload from the store every id differed: React keys
 * changed, anything keyed on the id was lost, and a stateless client posted
 * back a message the server never wrote.
 *
 * The client now names its copy (`turn.localId`) and the run answers with a
 * `message-id` frame, which the reducer applies as a rename.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

async function framesOf(response: Response): Promise<AgentStreamFrame[]> {
  const frames: AgentStreamFrame[] = [];
  let seq: number | undefined;
  for (const line of (await response.text()).split("\n")) {
    if (line.startsWith("id: ")) seq = Number(line.slice(4));
    if (line.startsWith("data: ")) {
      frames.push({ seq: seq ?? frames.length, event: JSON.parse(line.slice(6)) });
    }
  }
  return frames;
}

/** The copy a client shows the moment the user presses send. */
const localCopy = (id: string, text: string): AgentMessage => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  createdAt: new Date().toISOString(),
});

function chat(...answers: string[]) {
  const agent = Agent.create({
    name: "greeter",
    provider: fakeProvider(
      ...answers.map((text) => [{ type: "text-delta" as const, delta: text }, finish()]),
    ),
  });
  const store = new MemoryAgentStore({ clientOwnedIds: true });
  class Chat extends AgentController {
    agent = agent;
    liveRuns = new MemoryLiveRuns();
    store = store;
  }
  return { controller: new Chat(), store };
}

/** What the client holds once it has applied every frame of the turn. */
const reduced = (frames: AgentStreamFrame[], messages: AgentMessage[]) =>
  frames.reduce((state, frame) => applyFrame(state, frame), initialChatState({ messages }))
    .messages;

describe("the user message's server id reaches the client (#466)", () => {
  test("a threaded client ends up holding the ids the store holds", async () => {
    const { controller, store } = chat("hi there");
    const response = await controller.stream(
      jsonRequest({ threadId: "t1", turn: { text: "hello", localId: "local_1" } }),
    );
    const frames = await framesOf(response);
    await settle();

    const stored = (await store.loadThread("t1"))!;
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
    // Minted by the server, never the client's: see `ClientTurn.localId`.
    expect(stored[0]!.id).toMatch(/^msg_/);

    const live = reduced(frames, [localCopy("local_1", "hello")]);
    expect(live.map((message) => message.id)).toEqual(stored.map((message) => message.id));
  });

  test("a stateless client posts back the id the server minted", async () => {
    const { controller } = chat("first answer", "second answer");
    const first = await framesOf(
      await controller.stream(jsonRequest({ messages: [], turn: { text: "one", localId: "l1" } })),
    );
    const held = reduced(first, [localCopy("l1", "one")]);
    const event = first.find((frame) => frame.event.type === "message-id")!.event as {
      localId: string;
      messageId: string;
    };
    expect(event).toEqual({
      type: "message-id",
      localId: "l1",
      messageId: expect.any(String),
      // The stored turn, for a client attached from elsewhere (#778).
      message: expect.objectContaining({ id: event.messageId, role: "user" }),
    });
    expect(held[0]!.id).toBe(event.messageId);
  });

  test("the frame comes after run-start and before the answer starts", async () => {
    const { controller } = chat("hi");
    const types = (
      await framesOf(
        await controller.stream(jsonRequest({ messages: [], turn: { text: "x", localId: "l1" } })),
      )
    ).map((frame) => frame.event.type);
    expect(types.indexOf("message-id")).toBeGreaterThan(types.indexOf("run-start"));
    expect(types.indexOf("message-id")).toBeLessThan(types.indexOf("message-start"));
  });

  test("a client that names no copy is sent nothing new", async () => {
    const { controller } = chat("hi");
    const frames = await framesOf(
      await controller.stream(jsonRequest({ messages: [], turn: { text: "x" } })),
    );
    expect(frames.some((frame) => frame.event.type === "message-id")).toBe(false);
    // Nor is the turn itself echoed.
    expect(frames.some((frame) => frame.event.type === "message")).toBe(false);
  });

  test("in the bare form a top-level localId is the app's field, not the turn's", async () => {
    const { controller } = chat("hi");
    const frames = await framesOf(
      await controller.stream(jsonRequest({ messages: [], text: "x", localId: "mine" })),
    );
    expect(frames.some((frame) => frame.event.type === "message-id")).toBe(false);
  });

  test.each([
    ["a number", 42, /turn.localId must be a string/],
    ["an object", { id: "l1" }, /turn.localId must be a string/],
    ["an overlong string", "x".repeat(201), /longer than 200/],
  ])("a localId that is %s is a 400", async (_label, localId, message) => {
    const { controller } = chat("hi");
    const response = await controller.stream(
      jsonRequest({ messages: [], turn: { text: "x", localId } }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(message);
  });

  test.each([null, ""])("a localId of %j reads as absent", async (localId) => {
    const { controller } = chat("hi");
    const response = await controller.stream(
      jsonRequest({ messages: [], turn: { text: "x", localId } }),
    );
    expect(response.status).toBe(200);
    const frames = await framesOf(response);
    expect(frames.some((frame) => frame.event.type === "message-id")).toBe(false);
  });

  test("a regenerate on a thread renames the copy the client re-sent", async () => {
    const { controller, store } = chat("first", "second");
    await framesOf(
      await controller.stream(jsonRequest({ threadId: "t1", turn: { text: "q", localId: "l1" } })),
    );
    await settle();
    const frames = await framesOf(
      await controller.stream(
        jsonRequest({ threadId: "t1", regenerate: true, turn: { text: "q", localId: "l2" } }),
      ),
    );
    await settle();

    const stored = (await store.loadThread("t1"))!;
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
    const live = reduced(frames, [localCopy("l2", "q")]);
    expect(live.map((message) => message.id)).toEqual(stored.map((message) => message.id));
  });
});

/**
 * #778: a client already open on the thread attaches to a run another client
 * started after it mounted. Its cursor counts within an earlier run, so the
 * route replays the live run from its start, and what the client builds from
 * that has to be what the store holds.
 */
describe("a run another client started, attached to later (#778)", () => {
  async function startedElsewhere() {
    const { controller, store } = chat("hi there");
    const started = await framesOf(
      await controller.stream(
        jsonRequest({ threadId: "t1", turn: { text: "hello", localId: "local_theirs" } }),
      ),
    );
    await settle();
    const runId = (started[0]!.event as { runId: string }).runId;
    return { controller, store, runId };
  }

  test("the attaching client gets the question and the answer, under the stored ids", async () => {
    const { controller, store } = await startedElsewhere();
    const earlier: AgentMessage = {
      id: "msg_earlier",
      role: "assistant",
      content: [{ type: "text", text: "Earlier." }],
      createdAt: new Date().toISOString(),
      finishReason: "stop",
    };

    const response = await controller.attach(
      jsonRequest({ threadId: "t1", cursor: 7, runId: "run_before" }),
    );
    expect(response.status).toBe(200);
    const live = reduced(await framesOf(response), [earlier]);

    const stored = (await store.loadThread("t1"))!;
    expect(live.map((message) => message.id)).toEqual([
      "msg_earlier",
      ...stored.map((message) => message.id),
    ]);
    expect(live[1]!.content).toEqual([{ type: "text", text: "hello" }]);
    expect(live[2]!.content).toEqual(stored[1]!.content);
  });

  test("a thread read while it ran is rebuilt by the replay, not printed twice", async () => {
    const { controller, store, runId } = await startedElsewhere();
    const stored = (await store.loadThread("t1"))!;
    // What a read mid-run held: the turn, and the answer so far with its run's
    // id and no finish reason.
    const { finishReason: _finished, usage: _usage, ...answer } = stored[1]!;
    const midRun: AgentMessage[] = [
      stored[0]!,
      { ...answer, runId, content: [{ type: "text", text: "hi" }] },
    ];

    const live = reduced(
      await framesOf(await controller.attach(jsonRequest({ threadId: "t1", cursor: -1 }))),
      midRun,
    );

    expect(live.map((message) => message.id)).toEqual(stored.map((message) => message.id));
    expect(live[1]!.content).toEqual(stored[1]!.content);
    expect(live[1]!.finishReason).toBe("stop");
  });

  test("a client that did not start the run stops it by the thread", async () => {
    const { controller } = chat("hi");
    const response = await controller.stream(
      jsonRequest({ threadId: "t2", turn: { text: "hello", localId: "local_theirs" } }),
    );
    // Before the first frame is read: the run is live, and this request names
    // nothing but the thread, as an idle `useChat` on it does.
    const stopped = await controller.stop(jsonRequest({ threadId: "t2" }));
    expect(stopped).toEqual({ stopped: true });
    await framesOf(response);
  });
});
