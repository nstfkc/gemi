process.env.SECRET ??= "agent-controller-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { Agent, AgentTool, type AgentStreamParams } from "./Agent";
import {
  AgentController,
  defaultAgentStore,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";
import { StubAgentRun } from "./store/stubAgentRun";
import type { AgentMessage, AgentStreamEvent, PendingToolCall } from "./types";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const message = (id: string, role: AgentMessage["role"], text: string): AgentMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
  createdAt: new Date(0).toISOString(),
  finishReason: "stop",
});

/**
 * The smallest thing that answers `controller.agent`.
 *
 * Only `stream` and `provider.upload` are ever reached, and both are recorded
 * rather than faked deeply: the point of these tests is what the controller
 * hands the agent and what it does with the run, not what an agent does with a
 * turn.
 */
function stubAgent(run: StubAgentRun) {
  const calls: AgentStreamParams[] = [];
  const uploads: Blob[] = [];
  return {
    calls,
    uploads,
    agent: {
      name: "stub",
      tools: [] as const,
      skills: [] as const,
      output: undefined,
      provider: {
        upload: async (file: File) => {
          uploads.push(file);
          return "file_123";
        },
      },
      stream: (params: AgentStreamParams) => {
        calls.push(params);
        return run;
      },
    } as any,
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

/** A POST whose body is whatever bytes are handed to it, valid JSON or not. */
function rawRequest(body: string, contentType = "application/json") {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

async function readSse(response: Response): Promise<string> {
  return await response.text();
}

/** The events in an SSE body, in order. */
async function eventsOf(response: Response): Promise<AgentStreamEvent[]> {
  return (await readSse(response))
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

describe("AgentController.stream", () => {
  test("runs stateless on the history the client sent", async () => {
    const run = new StubAgentRun("run_1");
    const { agent, calls } = stubAgent(run);

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = new MemoryAgentStore();
    }

    const controller = new Chat();
    const history = [message("u0", "user", "earlier"), message("a0", "assistant", "sure")];
    const response = await controller.stream(
      jsonRequest({ messages: history, text: "and now this" }),
    );

    expect(response.headers.get("X-Stub-Run")).toBe("run_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages.map((m) => m.id)).toEqual(["u0", "a0"]);
    expect(calls[0]!.turn).toEqual({ text: "and now this" });
    expect(calls[0]!.threadId).toBeUndefined();

    // Nothing was written anywhere: statelessness is not a mode, it is what
    // happens when no threadId arrives.
    run.finish({ messages: [message("u1", "user", "and now this")] });
    await settle();
    expect(await controller.store.loadThread("anything")).toBeNull();
  });

  test("reads history from the store and appends the run to it when threaded", async () => {
    const run = new StubAgentRun("run_2");
    const { agent, calls } = stubAgent(run);
    const store = new MemoryAgentStore();
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("u0", "user", "earlier")]);

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
    }

    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId, text: "next" }));

    expect(calls[0]!.messages.map((m) => m.id)).toEqual(["u0"]);
    expect(calls[0]!.threadId).toBe(threadId);
    // The client's own `messages` are ignored once a thread owns the history —
    // otherwise a client could rewrite what the server already believes.
    expect(calls[0]!.messages).toHaveLength(1);

    run.finish({
      messages: [message("u1", "user", "next"), message("a1", "assistant", "ok")],
    });
    await settle();

    expect((await store.loadThread(threadId))!.map((m) => m.id)).toEqual(["u0", "u1", "a1"]);
  });

  /**
   * The message that made the call comes back from the second run under the
   * id it already had, with the result attached. Persisting that turn must
   * replace the earlier copy, not sit next to it — otherwise every later turn
   * sends the model the same call twice.
   *
   * This one runs a real `Agent` over a scripted provider rather than a stub
   * run: what the store ends up holding depends on what the agent reports,
   * and a stub run reports whatever the test hands it.
   */
  test("a threaded approval leaves one message per id in the store", async () => {
    const refunded: string[] = [];
    const refundOrder = AgentTool.create({
      name: "refundOrder",
      description: "Refund an order",
      inputSchema: s.object({ orderId: s.string() }),
      outputSchema: s.object({ refundId: s.string() }),
      requiresApproval: true,
      execute: async ({ orderId }) => {
        refunded.push(orderId);
        return { refundId: `rf_${orderId}` };
      },
    });
    const provider = fakeProvider(
      [
        { type: "tool-call", toolCallId: "c1", name: "refundOrder", args: '{"orderId":"ord_1"}' },
        finish(),
      ],
      [{ type: "text-delta", delta: "refunded" }, finish()],
    );
    const agent = Agent.create({ name: "support", provider, tools: [refundOrder] });
    const store = new MemoryAgentStore();
    // Minted by the store: an id it has never seen is a 404 before the run,
    // and this test is about what the second run leaves behind.
    const { threadId } = await store.createThread({});

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
    }

    const first = await eventsOf(
      await new Chat().stream(jsonRequest({ threadId, text: "refund it" })),
    );
    await settle();
    const awaiting = first.find((event) => event.type === "awaiting-input") as any;
    expect(awaiting?.pending).toHaveLength(1);
    expect(refunded).toEqual([]);

    await eventsOf(
      await new Chat().stream(
        jsonRequest({
          threadId,
          toolResults: [
            { toolCallId: "c1", signature: awaiting.pending[0].signature, approve: true },
          ],
        }),
      ),
    );
    await settle();

    expect(refunded).toEqual(["ord_1"]);
    const held = (await store.loadThread(threadId))!;
    const ids = held.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The copy that survived is the amended one, in the place the original had.
    const amended = held.find((m) => m.content.some((part) => part.type === "tool-call"))!;
    expect(held.indexOf(amended)).toBe(1);
    expect(amended.content.map((part) => part.type)).toEqual(["tool-call", "tool-result"]);
    const calls = held.flatMap((m) => m.content).filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(1);
  });

  /**
   * The controller is constructed per request, so anything process-lived it
   * holds has to come from outside it. This is the test that fails if `store`
   * goes back to being a field initializer.
   */
  test("keeps a thread across the fresh controller each request gets", async () => {
    const first = new StubAgentRun("run_2a");
    const second = new StubAgentRun("run_2b");
    const runs = [first, second];
    const seen: AgentStreamParams[] = [];

    class Chat extends AgentController {
      agent = {
        provider: {},
        stream: (params: AgentStreamParams) => {
          seen.push(params);
          return runs.shift()!;
        },
      } as any;
      liveRuns = new MemoryLiveRuns();
    }

    const { threadId } = await defaultAgentStore.createThread({});

    await new Chat().stream(jsonRequest({ threadId, text: "one" }));
    first.finish({ messages: [message("u1", "user", "one")] });
    await settle();

    await new Chat().stream(jsonRequest({ threadId, text: "two" }));
    second.finish({ messages: [message("u2", "user", "two")] });
    await settle();

    expect(seen[1]!.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  test("answers 404 for a thread the store does not have, before anything runs", async () => {
    const run = new StubAgentRun("run_404");
    const { agent, calls } = stubAgent(run);
    let instructed = false;

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = new MemoryAgentStore();
      instructions() {
        instructed = true;
      }
    }

    const controller = new Chat();
    const response = await controller.stream(jsonRequest({ threadId: "mistyped", text: "hi" }));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("thread_not_found");
    // Not an empty conversation: no run was started, no app code ran, and
    // nothing was registered for a client to attach to.
    expect(calls).toHaveLength(0);
    expect(instructed).toBe(false);
    expect(await controller.liveRuns.find({ threadId: "mistyped" })).toBeNull();
    run.finish();
  });

  test("a thread that expired is the same 404, not a fresh conversation under its id", async () => {
    const run = new StubAgentRun("run_ttl");
    const { agent, calls } = stubAgent(run);
    const store = new MemoryAgentStore({ ttlMs: 10 });
    const { threadId } = await store.createThread({});
    await store.appendMessages(threadId, [message("u0", "user", "a day ago")]);
    store.sweep(Date.now() + 90_000);

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
    }

    const response = await new Chat().stream(jsonRequest({ threadId, text: "still there?" }));

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
    // The id was not quietly re-minted by the miss.
    expect(await store.loadThread(threadId)).toBeNull();
    run.finish();
  });

  test("a store whose ids are the client's takes a first turn on a new id", async () => {
    const run = new StubAgentRun("run_own");
    const { agent, calls } = stubAgent(run);
    const store = new MemoryAgentStore({ clientOwnedIds: true });

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
    }

    const response = await new Chat().stream(
      jsonRequest({ threadId: "client-minted", text: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(calls[0]!.messages).toEqual([]);
    run.finish({ messages: [message("u1", "user", "hi"), message("a1", "assistant", "hello")] });
    await settle();

    expect((await store.loadThread("client-minted"))!.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  test("fires onMessage for user and assistant messages alike", async () => {
    const run = new StubAgentRun("run_3");
    const { agent } = stubAgent(run);
    const seen: string[] = [];

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      protected onMessage(m: AgentMessage) {
        seen.push(`${m.role}:${m.id}`);
      }
    }

    const controller = new Chat();
    await controller.stream(jsonRequest({ text: "hi" }));
    run.finish({
      messages: [message("u1", "user", "hi"), message("a1", "assistant", "hello")],
    });
    await settle();

    expect(seen).toEqual(["user:u1", "assistant:a1"]);
  });

  test("fires onToolCall, onAwaitingInput and onError off the event stream", async () => {
    const run = new StubAgentRun("run_4");
    const { agent } = stubAgent(run);
    const toolCalls: string[] = [];
    const pendingSeen: PendingToolCall[][] = [];
    const errors: string[] = [];

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      protected onToolCall(call: { name: string }) {
        toolCalls.push(call.name);
      }
      protected onAwaitingInput(pending: PendingToolCall[]) {
        pendingSeen.push(pending);
      }
      protected onError(error: { message: string }) {
        errors.push(error.message);
      }
    }

    const controller = new Chat();
    await controller.stream(jsonRequest({ text: "hi" }));

    // A partial tool call is skipped: its input is still half-parsed.
    run.emit({
      type: "tool-call",
      messageId: "a1",
      part: { type: "tool-call", toolCallId: "c1", name: "bash", input: {}, partial: true },
    } as AgentStreamEvent);
    run.emit({
      type: "tool-call",
      messageId: "a1",
      part: { type: "tool-call", toolCallId: "c1", name: "bash", input: { command: "ls" } },
    } as AgentStreamEvent);
    // A re-sent frame is the server's copy of a call the hook has already
    // seen — a parked sub-run's signed record rides on it — not a second call.
    run.emit({
      type: "tool-call",
      messageId: "a1",
      part: { type: "tool-call", toolCallId: "c1", name: "bash", input: { command: "ls" } },
      resent: true,
    } as AgentStreamEvent);
    run.emit({
      type: "awaiting-input",
      runId: "run_4",
      pending: [{ toolCallId: "c1", name: "bash", input: {}, kind: "approval", signature: "s" }],
    } as AgentStreamEvent);
    run.emit({
      type: "error",
      error: { code: "provider_error", message: "boom", retryable: true },
    });
    run.finish();
    await settle();

    expect(toolCalls).toEqual(["bash"]);
    expect(pendingSeen).toHaveLength(1);
    expect(errors).toEqual(["boom"]);
  });

  test("a hook that throws is reported and the run survives it", async () => {
    const run = new StubAgentRun("run_5");
    const { agent } = stubAgent(run);
    const reported: unknown[] = [];

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = new MemoryAgentStore();
      protected onMessage(): void {
        throw new Error("the app's database is down");
      }
      protected reportHookFailure(error: unknown) {
        reported.push(error);
      }
    }

    const controller = new Chat();
    const { threadId } = await controller.store.createThread({});
    await controller.stream(jsonRequest({ threadId, text: "hi" }));
    run.finish({
      messages: [message("u1", "user", "hi"), message("a1", "assistant", "hello")],
    });
    await settle();

    expect(reported).toHaveLength(2);
    // The run still finished and the framework store still has the turn: the
    // app's failure cost the app's row, not the answer.
    expect((await controller.store.loadThread(threadId))!.map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});

describe("one live run per thread", () => {
  /** A controller whose agent hands out the given runs, in order. */
  function threaded(runs: StubAgentRun[], store = new MemoryAgentStore()) {
    const queue = runs.slice();
    const seen: AgentStreamParams[] = [];
    const liveRuns = new MemoryLiveRuns();
    class Chat extends AgentController {
      agent = {
        provider: {},
        stream: (params: AgentStreamParams) => {
          seen.push(params);
          return queue.shift()!;
        },
      } as any;
      liveRuns = liveRuns;
      store = store;
    }
    return { Chat, seen, store, liveRuns };
  }

  /**
   * The issue's interleaving. A send while the first answer is streaming used
   * to abort only the connection, which no longer stops a run: the first kept
   * going, blind to the second turn; the second loaded a history without the
   * first's answer; and both appended when they finished, in whichever order
   * the model returned them. With the first slower, the thread read
   * `user2, assistant2, user1, assistant1`.
   */
  test("a second turn stops the first run and waits for its transcript to land", async () => {
    const first = new StubAgentRun("run_1");
    const second = new StubAgentRun("run_2");
    const { Chat, seen, store } = threaded([first, second]);
    const threadId = `t-${crypto.randomUUID()}`;

    await new Chat().stream(jsonRequest({ threadId, text: "first" }));
    expect(first.stopped).toBe(false);

    // Held, not refused: this resolves only once the first run is in the store.
    let started = false;
    const pending = new Chat()
      .stream(jsonRequest({ threadId, text: "second" }))
      .then((response) => {
        started = true;
        return response;
      });
    await settle();

    expect(first.stopped).toBe(true);
    expect(started).toBe(false);
    // The second run has not been asked for, so nothing has loaded the thread
    // without the first answer in it.
    expect(seen).toHaveLength(1);

    // The provider answering in reverse order: the first run finishes last from
    // the client's point of view, but the second cannot start before it.
    first.finish({
      messages: [message("u1", "user", "first"), message("a1", "assistant", "one…")],
    });
    const response = await pending;
    expect(response.headers.get("X-Stub-Run")).toBe("run_2");
    expect(seen[1]!.messages.map((m) => m.id)).toEqual(["u1", "a1"]);

    second.finish({
      messages: [message("u2", "user", "second"), message("a2", "assistant", "two")],
    });
    await settle();

    expect((await store.loadThread(threadId)).map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  /**
   * Two turns arriving together both see the same live run, both stop it and
   * both wait for it; without the lock both then start, and the third answer
   * never sees the second turn — the same race, one message later.
   */
  test("a third turn waits for the second, not just for the first", async () => {
    const runs = [new StubAgentRun("run_1"), new StubAgentRun("run_2"), new StubAgentRun("run_3")];
    const { Chat, seen, store } = threaded(runs);
    const threadId = `t-${crypto.randomUUID()}`;

    await new Chat().stream(jsonRequest({ threadId, text: "first" }));
    const second = new Chat().stream(jsonRequest({ threadId, text: "second" }));
    const third = new Chat().stream(jsonRequest({ threadId, text: "third" }));
    await settle();
    expect(seen).toHaveLength(1);

    runs[0]!.finish({
      messages: [message("u1", "user", "first"), message("a1", "assistant", "one")],
    });
    await second;
    await settle();
    // The third found the second registered and stopped that, rather than
    // starting alongside it.
    expect(seen).toHaveLength(2);
    expect(runs[1]!.stopped).toBe(true);

    runs[1]!.finish({
      messages: [message("u2", "user", "second"), message("a2", "assistant", "two")],
    });
    await third;
    expect(seen[2]!.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);

    runs[2]!.finish({
      messages: [message("u3", "user", "third"), message("a3", "assistant", "three")],
    });
    await settle();
    expect((await store.loadThread(threadId)).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
  });

  test("a finished run still within its ttl holds nothing up", async () => {
    const first = new StubAgentRun("run_1");
    const second = new StubAgentRun("run_2");
    const { Chat, seen } = threaded([first, second]);
    const threadId = `t-${crypto.randomUUID()}`;

    await new Chat().stream(jsonRequest({ threadId, text: "first" }));
    first.finish({ messages: [message("u1", "user", "first")] });
    await settle();

    await new Chat().stream(jsonRequest({ threadId, text: "second" }));
    expect(seen).toHaveLength(2);
    second.finish();
  });

  test("stateless turns are not serialized: there is no thread to hold", async () => {
    const first = new StubAgentRun("run_1");
    const second = new StubAgentRun("run_2");
    const { Chat, seen } = threaded([first, second]);

    await new Chat().stream(jsonRequest({ text: "first" }));
    await new Chat().stream(jsonRequest({ text: "second" }));

    expect(seen).toHaveLength(2);
    expect(first.stopped).toBe(false);
    first.finish();
    second.finish();
  });
});

describe("AgentController.attach", () => {
  function attachable(runId = "run_a") {
    const run = new StubAgentRun(runId);
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      // These tests are about the live-run map and name their threads by hand;
      // a store whose ids are the client's is the one that takes a hand-picked
      // id as a conversation rather than a 404.
      store = new MemoryAgentStore({ clientOwnedIds: true });
    }
    return { run, controller: new Chat() };
  }

  test("returns exactly the tail from the requested cursor", async () => {
    const { run, controller } = attachable();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (const delta of ["a", "b", "c", "d"]) {
      run.emit({ type: "text-delta", messageId: "m1", delta });
    }
    run.finish();
    await settle();

    const response = await controller.attach(jsonRequest({ threadId: "t1", from: 3 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const body = await readSse(response);
    expect(body).toContain("id: 3");
    expect(body).toContain("id: 4");
    expect(body).not.toContain("id: 2");
    expect(body).toContain('"delta":"c"');
    expect(body).not.toContain('"delta":"b"');
  });

  test("takes Last-Event-ID as the cursor when the body names none", async () => {
    const { run, controller } = attachable("run_b");
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (const delta of ["a", "b", "c"]) {
      run.emit({ type: "text-delta", messageId: "m1", delta });
    }
    run.finish();
    await settle();

    // The header names the last event *received*, so resuming means one past it.
    const response = await controller.attach(
      jsonRequest({ threadId: "t1" }, { "Last-Event-ID": "1" }),
    );
    const body = await readSse(response);
    expect(body).toContain("id: 2");
    expect(body).not.toContain("id: 1");
    expect(body).not.toContain("id: 0");
  });

  // `useChat` sends `cursor` (the last frame it APPLIED) and `runId` (the run
  // that number counts within). The controller was written against `from` and
  // `Last-Event-ID` alone, so the four tests below are the seam between the two
  // halves, which never met until the stack was assembled.
  test("takes the client's `cursor` as one-past, the way Last-Event-ID is read", async () => {
    const { run, controller } = attachable("run_cur");
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (const delta of ["a", "b", "c", "d"]) {
      run.emit({ type: "text-delta", messageId: "m1", delta });
    }
    run.finish();
    await settle();

    const response = await controller.attach(
      jsonRequest({ threadId: "t1", cursor: 2, runId: "run_cur" }),
    );
    const body = await readSse(response);
    expect(body).toContain("id: 3");
    expect(body).not.toContain("id: 2");
    expect(body).toContain('"delta":"c"');
    expect(body).not.toContain('"delta":"b"');
  });

  test("reads cursor -1 as no position at all, so a long run does not 410", async () => {
    const { run, controller } = attachable("run_neg");
    const liveRuns = new MemoryLiveRuns({ maxFrames: 8 });
    (controller as { liveRuns: MemoryLiveRuns }).liveRuns = liveRuns;
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    // Past the buffer, so frame 0 is long gone. This is the mount-time reattach
    // the route exists for: a client with no restored cursor sends -1, and
    // reading that as "frame 0" would 410 exactly the runs worth rescuing.
    for (let i = 0; i < 40; i++) {
      run.emit({ type: "text-delta", messageId: "m1", delta: String(i) });
    }
    run.finish();
    await settle();

    const response = await controller.attach(
      jsonRequest({ threadId: "t1", cursor: -1, runId: "run_neg" }),
    );
    expect(response.status).toBe(200);
    const body = await readSse(response);
    expect(body).toContain("id: 40");
  });

  test("forfeits a cursor that counts within a run which is not the live one", async () => {
    const { run, controller } = attachable("run_two");
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (const delta of ["a", "b", "c", "d"]) {
      run.emit({ type: "text-delta", messageId: "m1", delta });
    }
    run.finish();
    await settle();

    // The client applied frames of an EARLIER run on this thread. seq restarts
    // in every run, so honouring that 2 here would swallow the head of a run it
    // has seen nothing of.
    const response = await controller.attach(
      jsonRequest({ threadId: "t1", cursor: 2, runId: "run_one" }),
    );
    const body = await readSse(response);
    expect(body).toContain("id: 1");
    expect(body).toContain('"delta":"a"');
  });

  test("an absent runId is an older question, not a wrong answer", async () => {
    const { run, controller } = attachable("run_bare");
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (const delta of ["a", "b", "c", "d"]) {
      run.emit({ type: "text-delta", messageId: "m1", delta });
    }
    run.finish();
    await settle();

    // `from` and `Last-Event-ID` predate the cursor/runId pairing and carry no
    // run; an EventSource reconnecting on its own will never grow one. They
    // must keep resuming rather than being read as a mismatch.
    const body = await readSse(await controller.attach(jsonRequest({ threadId: "t1", from: 3 })));
    expect(body).toContain("id: 3");
    expect(body).not.toContain("id: 2");
  });

  test("misses explicitly when no run is in flight in this process", async () => {
    const { controller } = attachable("run_c");
    const response = await controller.attach(jsonRequest({ threadId: "nothing-here" }));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_live_run");
  });

  test("refuses a threadless attach", async () => {
    const { controller } = attachable("run_d");
    const response = await controller.attach(jsonRequest({}));
    expect(response.status).toBe(400);
  });

  /**
   * The case `/attach` exists for. A page reattaching on mount sends a fresh
   * POST: no `Last-Event-ID`, and no cursor of its own, because the only handle
   * it was ever given is the `threadId`. Reading that as frame 0 made every run
   * longer than the buffer — a few hundred tokens of prose — answer 410, and
   * the documented remedy of reloading the thread does not help, because the
   * store is not written until the run ends. So the user refreshed, saw
   * nothing, and the run kept spending invisibly.
   */
  test("with no cursor at all, returns the tail of a run past the buffer", async () => {
    const run = new StubAgentRun("run_long");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns({ maxFrames: 4 });
      store = new MemoryAgentStore({ clientOwnedIds: true });
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (let i = 0; i < 10; i++) {
      run.emit({ type: "text-delta", messageId: "m1", delta: String(i) });
    }
    run.finish();
    await settle();

    const response = await controller.attach(jsonRequest({ threadId: "t1" }));

    expect(response.status).toBe(200);
    const body = await readSse(response);
    expect(body).toContain("id: 7");
    expect(body).toContain("id: 10");
    expect(body).not.toContain("id: 6");
  });

  test("with no cursor and nothing dropped, returns the run from the start", async () => {
    const { run, controller } = attachable("run_short");
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (const delta of ["a", "b"]) {
      run.emit({ type: "text-delta", messageId: "m1", delta });
    }
    run.finish();
    await settle();

    const body = await readSse(await controller.attach(jsonRequest({ threadId: "t1" })));
    expect(body).toContain("id: 1");
    expect(body).toContain("id: 2");
  });

  test("answers 410 for a cursor the buffer has dropped", async () => {
    const run = new StubAgentRun("run_e");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns({ maxFrames: 4 });
      store = new MemoryAgentStore({ clientOwnedIds: true });
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (let i = 0; i < 10; i++) {
      run.emit({ type: "text-delta", messageId: "m1", delta: String(i) });
    }
    run.finish();
    await settle();

    // Explicitly `from: 1`: this client says its transcript starts at the run's
    // first frame, so handing it frame 7 onwards would leave a hole it cannot
    // see. That is the 410, and it is exactly the request a client with no
    // cursor is NOT making. `from: 0` is a different question — "everything you
    // still have" — and on a run that dropped nothing it is answerable.
    const response = await controller.attach(jsonRequest({ threadId: "t1", from: 1 }));
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: { code: string; oldestSeq: number } };
    expect(body.error.code).toBe("frame_cursor_evicted");
    expect(body.error.oldestSeq).toBe(7);
  });
});

describe("AgentController.stop", () => {
  test("returns as soon as the run is aborted, not when it has unwound", async () => {
    const run = new StubAgentRun("run_s");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = new MemoryAgentStore({ clientOwnedIds: true });
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));
    await settle();

    const resolved = await controller.stop(
      jsonRequest({ threadId: "t1", reason: "changed my mind" }),
    );

    expect(resolved).toEqual({ stopped: true });
    expect(run.stopped).toBe(true);
    expect(run.stopReason).toBe("changed my mind");
    // The run has NOT finished unwinding: `result()` is still pending, and the
    // terminal events are still to come on the run's own stream.
    const raced = await Promise.race([
      run.result().then(() => "unwound"),
      settle().then(() => "still going"),
    ]);
    expect(raced).toBe("still going");

    run.finish({ finishReason: "aborted" });
  });

  test("stops by runId as well as by thread", async () => {
    const run = new StubAgentRun("run_t");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ text: "hi" }));

    expect(await controller.stop(jsonRequest({ runId: "run_t" }))).toEqual({ stopped: true });
    run.finish();
  });

  test("stops a run the client named before the server had, on a stateless turn", async () => {
    const run = new StubAgentRun("run_early");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const controller = new Chat();
    // No threadId — a stateless first turn. Between this POST and `run-start`
    // reaching the client there is no `runId` either, and that window is where
    // a user presses stop. `clientRunId` is the only handle that exists.
    await controller.stream(jsonRequest({ clientRunId: "local_run_1", text: "hi" }));

    expect(await controller.stop(jsonRequest({ clientRunId: "local_run_1" }))).toEqual({
      stopped: true,
    });
    expect(run.stopped).toBe(true);
    run.finish({ finishReason: "aborted" });
  });

  test("a clientRunId that named no run here is nothing to stop, not a crash", async () => {
    const run = new StubAgentRun("run_unknown");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    expect(await new Chat().stop(jsonRequest({ clientRunId: "local_nope" }))).toEqual({
      stopped: false,
    });
    run.finish();
  });

  test("says so rather than throwing when there is nothing to stop", async () => {
    const run = new StubAgentRun("run_u");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    expect(await new Chat().stop(jsonRequest({ threadId: "gone" }))).toEqual({ stopped: false });
    run.finish();
  });
});

describe("AgentController.upload", () => {
  test("hands the file to the provider and returns its id", async () => {
    const run = new StubAgentRun("run_v");
    const { agent, uploads } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }

    const form = new FormData();
    form.set("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const raw = new Request("http://localhost/api/chat/files", { method: "POST", body: form });

    const result = await new Chat().upload(new HttpRequest(raw, {}, "api", "/chat/files"));

    expect(result).toEqual({ fileId: "file_123" });
    expect(uploads).toHaveLength(1);
  });

  test("refuses a body with no file field", async () => {
    const run = new StubAgentRun("run_w");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const raw = new Request("http://localhost/api/chat/files", {
      method: "POST",
      body: new FormData(),
    });
    await expect(new Chat().upload(new HttpRequest(raw, {}, "api", "/chat/files"))).rejects.toThrow(
      /file/,
    );
    run.finish();
  });
});

describe("AgentController.instructions", () => {
  test("is appended to the agent's own for this request", async () => {
    const run = new StubAgentRun("run_x");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      instructions() {
        return "Today is Tuesday.";
      }
    }
    await new Chat().stream(jsonRequest({ text: "hi" }));
    expect(calls[0]!.instructions).toBe("Today is Tuesday.");
    run.finish();
  });
});

describe("the request body", () => {
  test("accepts a charset on the content type, which several clients send", async () => {
    const run = new StubAgentRun("run_y");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const raw = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text: "hi" }),
    });
    const response = await new Chat().stream(new HttpRequest(raw, {}, "api", "/chat"));
    expect(response.status).toBe(200);
    expect(calls[0]!.turn).toEqual({ text: "hi" });
    run.finish();
  });

  /** Media types are case-insensitive, and some proxies rewrite them. */
  test("matches the content type without regard to case", async () => {
    const run = new StubAgentRun("run_case");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const response = await new Chat().stream(
      rawRequest(JSON.stringify({ text: "hi" }), "Application/JSON; charset=UTF-8"),
    );
    expect(response.status).toBe(200);
    expect(calls[0]!.turn).toEqual({ text: "hi" });
    run.finish();
  });

  /**
   * The CSRF shape: a cross-site `<form enctype="text/plain">` whose single
   * field is named `{"text":"` and valued `"}` posts exactly this body, and the
   * browser sends it without a preflight. Parsing it would let any page on the
   * web take a turn on a logged-in user's conversation. The refusal comes
   * before the body is looked at, so it is the same for one that is valid JSON
   * as for one that is not.
   */
  test("refuses a body that is not application/json with a 415", async () => {
    const run = new StubAgentRun("run_415");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }

    const response = await new Chat().stream(rawRequest('{"text":"hi"}', "text/plain"));
    expect(response.status).toBe(415);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unsupported_media_type");
    expect(body.error.message).toContain("application/json");
    // No run was started for it.
    expect(calls).toHaveLength(0);

    // The last one begins with the accepted bytes and is still another type.
    for (const contentType of [
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "application/json-seq",
    ]) {
      expect((await new Chat().stream(rawRequest("text=hi", contentType))).status).toBe(415);
    }
    expect(calls).toHaveLength(0);
    run.finish();
  });

  /**
   * A body with no type at all. Bun's `Request` leaves a string body untyped,
   * which is what this builds; a browser would have filled in
   * `text/plain;charset=UTF-8`, which the test above refuses the same way.
   */
  test("refuses a body that carries no content type at all", async () => {
    const run = new StubAgentRun("run_notype");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const raw = new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(raw.headers.get("Content-Type")).toBeNull();
    const response = await new Chat().stream(new HttpRequest(raw, {}, "api", "/chat"));
    expect(response.status).toBe(415);
    expect(calls).toHaveLength(0);
    run.finish();
  });

  test("attach and stop hold the body to the same type", async () => {
    const run = new StubAgentRun("run_415b");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    const attached = await controller.attach(
      rawRequest(JSON.stringify({ threadId: "t1" }), "text/plain"),
    );
    expect(attached.status).toBe(415);

    const stopped = await controller.stop(
      rawRequest(JSON.stringify({ runId: "run_415b" }), "text/plain"),
    );
    expect(stopped).toBeInstanceOf(Response);
    expect((stopped as Response).status).toBe(415);
    expect(run.stopped).toBe(false);

    run.finish();
  });

  /**
   * A truncated proxy response and a mis-serialized client both land here. They
   * used to read as an empty turn, so `stream` billed a model call with no
   * history and no turn and dropped the user's message — which presents as the
   * model hallucinating rather than as an error.
   */
  test("refuses an unparseable body instead of billing an empty run", async () => {
    const run = new StubAgentRun("run_bad");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }

    const response = await new Chat().stream(rawRequest('{"text": "hi"'));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    // The point: no run was ever started.
    expect(calls).toHaveLength(0);
    run.finish();
  });

  test("refuses a JSON array, which typeof would have let through", async () => {
    const run = new StubAgentRun("run_arr");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }

    expect((await new Chat().stream(rawRequest("[1,2,3]"))).status).toBe(400);
    expect((await new Chat().stream(rawRequest("null"))).status).toBe(400);
    expect(calls).toHaveLength(0);
    run.finish();
  });

  test("attach and stop refuse a malformed body too", async () => {
    const run = new StubAgentRun("run_bad2");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = new MemoryAgentStore({ clientOwnedIds: true });
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    expect((await controller.attach(rawRequest("{oops"))).status).toBe(400);

    // Not `{ stopped: false }`: that means "there was nothing to stop", and a
    // client that believes it stops asking while the run keeps going.
    const stopped = await controller.stop(rawRequest("{oops"));
    expect(stopped).toBeInstanceOf(Response);
    expect((stopped as Response).status).toBe(400);
    expect(run.stopped).toBe(false);

    run.finish();
  });

  /** An empty body is a real request — a turn that just lets the model continue
   *  — and stays a 200. Only a body that arrived and would not parse is a 400. */
  test("still accepts a request with no body at all", async () => {
    const run = new StubAgentRun("run_empty");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    const raw = new Request("http://localhost/api/chat", { method: "POST" });
    const response = await new Chat().stream(new HttpRequest(raw, {}, "api", "/chat"));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.turn).toBeUndefined();
    run.finish();
  });

  test("accepts the nested turn form too", async () => {
    const run = new StubAgentRun("run_z");
    const { agent, calls } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
    }
    await new Chat().stream(
      jsonRequest({
        turn: { text: "yes", toolResults: [{ toolCallId: "c1", signature: "s", approve: true }] },
      }),
    );
    expect(calls[0]!.turn).toEqual({
      text: "yes",
      toolResults: [{ toolCallId: "c1", signature: "s", approve: true }],
    });
    run.finish();
  });
});
