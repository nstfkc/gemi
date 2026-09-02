import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import type { AgentStreamParams } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
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
    expect(await controller.store.loadThread("anything")).toEqual([]);
  });

  test("reads history from the store and appends the run to it when threaded", async () => {
    const run = new StubAgentRun("run_2");
    const { agent, calls } = stubAgent(run);
    const store = new MemoryAgentStore();
    await store.appendMessages("t1", [message("u0", "user", "earlier")]);

    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
      store = store;
    }

    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "next" }));

    expect(calls[0]!.messages.map((m) => m.id)).toEqual(["u0"]);
    expect(calls[0]!.threadId).toBe("t1");
    // The client's own `messages` are ignored once a thread owns the history —
    // otherwise a client could rewrite what the server already believes.
    expect(calls[0]!.messages).toHaveLength(1);

    run.finish({
      messages: [message("u1", "user", "next"), message("a1", "assistant", "ok")],
    });
    await settle();

    expect((await store.loadThread("t1")).map((m) => m.id)).toEqual(["u0", "u1", "a1"]);
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

    const threadId = `t-${crypto.randomUUID()}`;

    await new Chat().stream(jsonRequest({ threadId, text: "one" }));
    first.finish({ messages: [message("u1", "user", "one")] });
    await settle();

    await new Chat().stream(jsonRequest({ threadId, text: "two" }));
    second.finish({ messages: [message("u2", "user", "two")] });
    await settle();

    expect(seen[1]!.messages.map((m) => m.id)).toEqual(["u1"]);
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
    await controller.stream(jsonRequest({ threadId: "t9", text: "hi" }));
    run.finish({
      messages: [message("u1", "user", "hi"), message("a1", "assistant", "hello")],
    });
    await settle();

    expect(reported).toHaveLength(2);
    // The run still finished and the framework store still has the turn: the
    // app's failure cost the app's row, not the answer.
    expect((await controller.store.loadThread("t9")).map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});

describe("AgentController.attach", () => {
  function attachable(runId = "run_a") {
    const run = new StubAgentRun(runId);
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
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

    const response = await controller.attach(jsonRequest({ threadId: "t1", from: 2 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const body = await readSse(response);
    expect(body).toContain("id: 2");
    expect(body).toContain("id: 3");
    expect(body).not.toContain("id: 1");
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
    expect(body).toContain("id: 6");
    expect(body).toContain("id: 9");
    expect(body).not.toContain("id: 5");
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
    expect(body).toContain("id: 0");
    expect(body).toContain("id: 1");
  });

  test("answers 410 for a cursor the buffer has dropped", async () => {
    const run = new StubAgentRun("run_e");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns({ maxFrames: 4 });
    }
    const controller = new Chat();
    await controller.stream(jsonRequest({ threadId: "t1", text: "hi" }));

    for (let i = 0; i < 10; i++) {
      run.emit({ type: "text-delta", messageId: "m1", delta: String(i) });
    }
    run.finish();
    await settle();

    // Explicitly `from: 0`: this client says its transcript ends at frame 0, so
    // handing it frame 6 onwards would leave a hole it cannot see. That is the
    // 410, and it is exactly the request a client with no cursor is NOT making.
    const response = await controller.attach(jsonRequest({ threadId: "t1", from: 0 }));
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: { code: string; oldestSeq: number } };
    expect(body.error.code).toBe("frame_cursor_evicted");
    expect(body.error.oldestSeq).toBe(6);
  });
});

describe("AgentController.stop", () => {
  test("returns as soon as the run is aborted, not when it has unwound", async () => {
    const run = new StubAgentRun("run_s");
    const { agent } = stubAgent(run);
    class Chat extends AgentController {
      agent = agent;
      liveRuns = new MemoryLiveRuns();
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
    await new Chat().stream(new HttpRequest(raw, {}, "api", "/chat"));
    expect(calls[0]!.turn).toEqual({ text: "hi" });
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
