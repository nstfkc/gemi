/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentStreamFrame } from "./types";
import { useChat, type UseChatResult } from "./useChat";

/**
 * The hook is thin on purpose — the decoding and the message reducer are tested
 * on their own, without a DOM — so what is left here is the part that only
 * exists in React: which URL is called with what body, when the UI is allowed
 * to say it is idle, and what happens on unmount.
 *
 * `useChat`'s path parameter is keyed off the app's `RPC`, which has no agent
 * routes in the package itself, so the calls below go through `any`. The types
 * are exercised by `Agent.test-d.ts` and by an application, not from here.
 */

type Api = UseChatResult<never>;

function encode(frames: AgentStreamFrame[]) {
  return frames.map((f) => `id: ${f.seq}\ndata: ${JSON.stringify(f.event)}\n\n`).join("");
}

function streamed(frames: AgentStreamFrame[]) {
  return new Response(encode(frames), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** A stream the test keeps open, so a run can be interrupted halfway. */
function controlled() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push(...frames: AgentStreamFrame[]) {
      controller.enqueue(encoder.encode(encode(frames)));
    },
    close() {
      controller.close();
    },
    // What a real fetch does when its signal fires, and the reason `stop()` can
    // trust the loop to end.
    abort() {
      controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
    },
  };
}

const ANSWER: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_1", threadId: "th_9" } },
  { seq: 1, event: { type: "message-start", messageId: "m1", role: "assistant" } },
  { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "Hi there." } },
  { seq: 3, event: { type: "message-end", messageId: "m1", finishReason: "stop" } },
  { seq: 4, event: { type: "run-end", runId: "run_1", finishReason: "stop" } },
];

const ASKING: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_2", threadId: "th_9" } },
  { seq: 1, event: { type: "message-start", messageId: "m2", role: "assistant" } },
  { seq: 2, event: { type: "text-delta", messageId: "m2", delta: "I need two things." } },
  {
    seq: 3,
    event: {
      type: "awaiting-input",
      runId: "run_2",
      pending: [
        {
          toolCallId: "tc_1",
          name: "charge",
          input: { amountCents: 500 },
          kind: "approval",
          signature: "sig_one",
        },
        {
          toolCallId: "tc_2",
          name: "refundOrder",
          input: { orderId: "o_1" },
          kind: "approval",
          signature: "sig_two",
        },
      ],
    },
  },
  { seq: 4, event: { type: "message-end", messageId: "m2", finishReason: "awaiting-input" } },
  { seq: 5, event: { type: "run-end", runId: "run_2", finishReason: "awaiting-input" } },
];

let fetchMock: ReturnType<typeof vi.fn>;

function mount(params: Record<string, unknown> = {}) {
  const box: { api: Api } = { api: null as unknown as Api };
  function Harness() {
    box.api = (useChat as any)("/chat", params);
    return <span data-testid="status">{box.api.status}</span>;
  }
  const rendered = render(<Harness />);
  return { ...rendered, box };
}

function calls() {
  return fetchMock.mock.calls as [string, RequestInit][];
}

/**
 * The request body, minus the correlation id.
 *
 * `clientRunId` is a fresh uuid on every send, so it cannot appear in an
 * equality assertion; it has its own tests below, which are the only place it is
 * interesting.
 */
function bodyOf(index: number) {
  const { clientRunId: _, ...body } = JSON.parse(calls()[index]![1]!.body as string);
  return body;
}

function rawBodyOf(index: number) {
  return JSON.parse(calls()[index]![1]!.body as string);
}

beforeEach(() => {
  fetchMock = vi.fn(async () => streamed(ANSWER));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("routes", () => {
  test("every route is derived from the path exactly as mounted", async () => {
    const run = controlled();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => run.abort());
      return run.response;
    });
    const { box } = mount({ threadId: "th_9", attach: false });

    await act(async () => {
      void box.api.sendMessage("hello");
    });
    await act(async () => {
      run.push(ANSWER[0]!);
      await Promise.resolve();
    });
    await act(async () => {
      await box.api.stop();
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fileId: "f_1" })));
    await act(async () => {
      await box.api.attach(new File(["x"], "a.txt", { type: "text/plain" }));
    });

    expect(calls().map((c) => c[0])).toEqual(["/api/chat", "/api/chat/stop", "/api/chat/files"]);
  });

  test("uploading returns the id alongside the file's own name and type", async () => {
    const { box } = mount({ attach: false });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fileId: "f_1" })));

    let result: unknown;
    await act(async () => {
      result = await box.api.attach(new File(["x"], "invoice.pdf", { type: "application/pdf" }));
    });

    expect(result).toEqual({ fileId: "f_1", name: "invoice.pdf", mimeType: "application/pdf" });
    expect(calls()[0]![1]!.body).toBeInstanceOf(FormData);
  });
});

describe("sendMessage", () => {
  test("shows the user's turn before the server has said anything", async () => {
    // A never-resolving request: the point is what the UI does while it waits.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { box } = mount({ attach: false });

    await act(async () => {
      void box.api.sendMessage("hello");
    });

    expect(box.api.messages).toHaveLength(1);
    expect(box.api.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(box.api.status).toBe("submitted");
  });

  test("streams the answer and lands back on idle", async () => {
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.sendMessage("hello");
    });

    expect(box.api.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(box.api.messages[1]!.content).toEqual([{ type: "text", text: "Hi there." }]);
    expect(box.api.messages[1]!.finishReason).toBe("stop");
    expect(box.api.status).toBe("idle");
    expect(box.api.threadId).toBe("th_9");
  });

  test("stateless: the client carries the history, and never the new turn twice", async () => {
    // A server that names no thread. The transcript is the client's to keep,
    // and it is the transcript *before* this turn — the turn itself travels in
    // `turn`, so including it would show the model the same message twice.
    const anonymous = ANSWER.map((frame, index) =>
      index === 0 ? { seq: 0, event: { type: "run-start" as const, runId: "run_1" } } : frame,
    );
    fetchMock.mockImplementation(async () => streamed(anonymous));
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.sendMessage("first");
    });
    await act(async () => {
      await box.api.sendMessage("second");
    });

    expect(bodyOf(0)).toEqual({ turn: { text: "first" }, messages: [] });
    const second = bodyOf(1);
    expect(second.turn).toEqual({ text: "second" });
    expect(second.messages).toHaveLength(2);
    expect(second.threadId).toBeUndefined();
  });

  test("once the server names a thread the client stops carrying the history", async () => {
    // Sending it anyway would be a second copy of a transcript the store
    // already has, growing every turn.
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.sendMessage("first");
    });
    await act(async () => {
      await box.api.sendMessage("second");
    });

    expect(bodyOf(1)).toEqual({ turn: { text: "second" }, threadId: "th_9" });
  });

  test("a threadId means the server owns the history", async () => {
    const { box } = mount({ threadId: "th_1", attach: false });

    await act(async () => {
      await box.api.sendMessage({ text: "hi", files: [{ fileId: "f_1" }] });
    });

    expect(bodyOf(0)).toEqual({
      turn: { text: "hi", files: [{ fileId: "f_1" }] },
      threadId: "th_1",
    });
  });

  test("body and headers ride along", async () => {
    const { box } = mount({
      attach: false,
      body: { locale: "en" },
      headers: { "X-Tenant": "acme" },
    });

    await act(async () => {
      await box.api.sendMessage("hi");
    });

    expect(bodyOf(0).locale).toBe("en");
    expect((calls()[0]![1]!.headers as Record<string, string>)["X-Tenant"]).toBe("acme");
  });
});

describe("awaiting input", () => {
  test("a parked run is neither streaming nor idle", async () => {
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    expect(box.api.status).toBe("awaiting-input");
    expect(box.api.pending).toHaveLength(2);
  });

  test("approvals answered in one tick become one turn, with the signatures untouched", async () => {
    // Sent separately, the first turn would deny the second call: a turn that
    // leaves a pending call unanswered refuses it.
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    await act(async () => {
      await Promise.all([box.api.approve("tc_1", true), box.api.approve("tc_2", false, "too old")]);
    });

    expect(calls()).toHaveLength(2);
    expect(bodyOf(1).turn).toEqual({
      toolResults: [
        { toolCallId: "tc_1", signature: "sig_one", approve: true },
        { toolCallId: "tc_2", signature: "sig_two", approve: false, reason: "too old" },
      ],
    });
  });

  test("answer() carries a value under the same signature", async () => {
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    await act(async () => {
      await box.api.answer("tc_1", { answer: "the March invoice" });
    });

    expect(bodyOf(1).turn.toolResults).toEqual([
      { toolCallId: "tc_1", signature: "sig_one", output: { answer: "the March invoice" } },
    ]);
  });

  test("pending clears the moment a turn goes out", async () => {
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    await act(async () => {
      void box.api.sendMessage("actually, never mind");
    });

    expect(box.api.pending).toEqual([]);
    expect(box.api.status).toBe("submitted");
  });

  test("answering a call this client is not holding is reported, not sent", async () => {
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.approve("tc_nope", true);
    });

    expect(calls()).toHaveLength(0);
    expect(box.api.error).toMatchObject({ code: "invalid_tool_result", retryable: false });
  });

  test("a bad toolCallId does not throw away the good ones standing next to it", async () => {
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    await act(async () => {
      await box.api.approve("tc_nope", true);
    });

    // The signatures are the only thing that can answer these calls and they are
    // held nowhere else; dropping them because one report was misaddressed
    // leaves the user unable to approve anything, with a fresh turn — which the
    // server reads as refusing everything — the only way out.
    expect(box.api.pending).toHaveLength(2);
    expect(box.api.status).toBe("awaiting-input");

    await act(async () => {
      await box.api.approve("tc_1", true);
    });

    expect(bodyOf(1).turn.toolResults).toEqual([
      { toolCallId: "tc_1", signature: "sig_one", approve: true },
    ]);
  });

  test("an unrelated failure leaves the standing question alone", async () => {
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    // An upload has nothing to do with the approvals the conversation is
    // holding, and failing one is no reason to make them unanswerable.
    fetchMock.mockResolvedValueOnce(new Response("too big", { status: 500 }));
    await act(async () => {
      await expect(
        box.api.attach(new File(["x"], "a.txt", { type: "text/plain" })),
      ).rejects.toThrow();
    });

    expect(box.api.pending).toHaveLength(2);
    expect(box.api.error).toMatchObject({ retryable: true });
    // With both set, awaiting-input wins: the question is still the thing the UI
    // has to put in front of the user.
    expect(box.api.status).toBe("awaiting-input");
  });
});

describe("stop", () => {
  test("the UI stops now, the run is ended by the route", async () => {
    const run = controlled();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => run.abort());
      return run.response;
    });
    const { box } = mount({ attach: false });

    await act(async () => {
      void box.api.sendMessage("write me an essay");
    });
    await act(async () => {
      run.push(ANSWER[0]!, ANSWER[1]!, ANSWER[2]!);
      await Promise.resolve();
    });
    expect(box.api.messages[1]!.content).toEqual([{ type: "text", text: "Hi there." }]);

    await act(async () => {
      await box.api.stop();
    });

    // The text the user already read is still there, marked as cut short.
    expect(box.api.messages[1]!.content).toEqual([{ type: "text", text: "Hi there." }]);
    expect(box.api.messages[1]!.finishReason).toBe("aborted");
    expect(box.api.status).toBe("idle");
    expect(calls()[1]![0]).toBe("/api/chat/stop");
    expect(JSON.parse(calls()[1]![1]!.body as string)).toMatchObject({ runId: "run_1" });
  });

  test("nothing running means nothing to stop", async () => {
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.stop();
    });

    expect(calls()).toHaveLength(0);
  });

  test("a run that has not named itself yet is still stopped", async () => {
    // Between the send and the first frame — the round trip plus the provider's
    // time to first token, longer if the agent searches for deferred tools — the
    // client has no `runId` and, on a stateless first turn, no `threadId`
    // either. That window is exactly where a user cancels, and a dropped
    // connection no longer stops the tool loop.
    const run = controlled();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => run.abort());
      return run.response;
    });
    const { box } = mount({ attach: false });

    await act(async () => {
      void box.api.sendMessage("write me an essay");
    });
    expect(box.api.runId).toBeUndefined();

    await act(async () => {
      await box.api.stop();
    });

    expect(calls().map((c) => c[0])).toEqual(["/api/chat", "/api/chat/stop"]);
    // The correlation id the client minted for the send, so the route has
    // something to resolve the run by when nothing else exists yet.
    expect(rawBodyOf(1)).toEqual({ clientRunId: rawBodyOf(0).clientRunId });
    expect(rawBodyOf(1).clientRunId).toMatch(/^local_/);
  });

  test("a run attached to, whose tail carried no run-start, is stoppable by thread", async () => {
    // The other half of the same hole: a tail replayed from a mid-run cursor has
    // no `run-start` in it, so `runId` never arrives, but the run is visibly
    // streaming and the thread is the handle the route resolves it by.
    const run = controlled();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => run.abort());
      return run.response;
    });
    const { box } = mount({ threadId: "th_9", cursor: { runId: "run_1", seq: 1 } });

    await act(async () => {
      run.push({ seq: 2, event: { type: "text-delta", messageId: "m1", delta: "…tail" } });
      await Promise.resolve();
    });
    expect(box.api.runId).toBeUndefined();

    await act(async () => {
      await box.api.stop();
    });

    expect(calls()[1]![0]).toBe("/api/chat/stop");
    expect(rawBodyOf(1)).toEqual({ threadId: "th_9" });
  });

  test("a stop the server refused is reported, not swallowed", async () => {
    // The transcript says the turn was cut, so the UI looks settled while the
    // run may still be working through its tool loop and billing for it.
    const run = controlled();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => run.abort());
      return run.response;
    });
    fetchMock.mockResolvedValueOnce(new Response("no such run", { status: 500 }));
    const onError = vi.fn();
    const { box } = mount({ attach: false, onError });

    await act(async () => {
      void box.api.sendMessage("hi");
    });
    await act(async () => {
      await box.api.stop();
    });

    expect(box.api.error).toMatchObject({ retryable: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("attach on mount", () => {
  test("asks the attach route, from the cursor this client left off at", async () => {
    fetchMock.mockResolvedValueOnce(streamed(ANSWER.slice(2)));
    const { box } = mount({ threadId: "th_9" });

    await act(async () => {
      await Promise.resolve();
    });

    expect(calls()[0]![0]).toBe("/api/chat/attach");
    expect(bodyOf(0)).toEqual({ threadId: "th_9", cursor: -1 });
    // The tail of a message this client never saw start.
    expect(box.api.messages).toHaveLength(1);
    expect(box.api.messages[0]!.content).toEqual([{ type: "text", text: "Hi there." }]);
    expect(box.api.status).toBe("idle");
  });

  test("asks for the tail from the cursor restored with the messages", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    mount({
      threadId: "th_9",
      initialMessages: [{ id: "m1", role: "user", content: [], createdAt: "" }],
      cursor: { runId: "run_1", seq: 3 },
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Both halves, and the run id is not decoration: frames number from zero in
    // every run, so "I got to 3" says nothing until the server knows which run
    // reached 3. Given the pair it can resume; given a mismatch it must replay.
    expect(bodyOf(0)).toEqual({ threadId: "th_9", cursor: 3, runId: "run_1" });
  });

  test("a full replay onto a restored transcript does not print the answer twice", async () => {
    // `LiveRuns` keeps a run alive past `run-end` so a refresh a second late
    // still sees the tail, which means the ordinary refresh right after an
    // answer gets that answer replayed. With no cursor to hand back — the app
    // persisted the messages and not the cursor — `seq` cannot recognise a
    // single frame of it.
    fetchMock.mockResolvedValueOnce(streamed(ANSWER));
    const onFinish = vi.fn();
    const { box } = mount({
      threadId: "th_9",
      onFinish,
      initialMessages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "" },
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "Hi there." }],
          createdAt: "",
          finishReason: "stop",
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(box.api.messages).toHaveLength(2);
    expect(box.api.messages[1]!.content).toEqual([{ type: "text", text: "Hi there." }]);
    // An app that persists in `onFinish` would otherwise write the message a
    // second time on every refresh.
    expect(onFinish).not.toHaveBeenCalled();
  });

  test("the cursor is handed back, so the next mount can restore it", async () => {
    const { box } = mount({ threadId: "th_9", attach: false });

    await act(async () => {
      await box.api.sendMessage("hello");
    });

    // What an app persists alongside `messages`; restoring one without the other
    // is what produced the doubled answer above.
    expect(box.api.cursor).toEqual({ runId: "run_1", seq: 4 });
  });

  test("nothing in flight is an ordinary answer, not an error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { box } = mount({ threadId: "th_9" });

    await act(async () => {
      await Promise.resolve();
    });

    expect(box.api.status).toBe("idle");
    expect(box.api.error).toBeNull();
  });

  test("no threadId, no probe: there is no handle to ask about", async () => {
    mount({});

    await act(async () => {
      await Promise.resolve();
    });

    expect(calls()).toHaveLength(0);
  });

  test("attach: false skips it", async () => {
    mount({ threadId: "th_9", attach: false });

    await act(async () => {
      await Promise.resolve();
    });

    expect(calls()).toHaveLength(0);
  });
});

describe("regenerate", () => {
  test("drops the last assistant turn and re-runs from the user turn before it", async () => {
    const { box } = mount({
      attach: false,
      initialMessages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "say hi" }], createdAt: "" },
        {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "no" }],
          createdAt: "",
          finishReason: "stop",
        },
      ],
    });

    await act(async () => {
      await box.api.regenerate();
    });

    expect(bodyOf(0).turn).toEqual({ text: "say hi" });
    // The user turn is re-sent, not duplicated.
    expect(box.api.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(box.api.messages[1]!.content).toEqual([{ type: "text", text: "Hi there." }]);
  });

  test("nothing to regenerate is a no-op", async () => {
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.regenerate();
    });

    expect(calls()).toHaveLength(0);
  });
});

describe("errors", () => {
  test("a pre-flight failure is an HTTP error translated into an AgentError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "not signed in" } }), { status: 401 }),
    );
    const onError = vi.fn();
    const { box } = mount({ attach: false, onError });

    await act(async () => {
      await box.api.sendMessage("hi");
    });

    expect(box.api.status).toBe("error");
    expect(box.api.error).toEqual({ code: "unknown", message: "not signed in", retryable: false });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("429 is retryable and named", async () => {
    fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    const { box } = mount({ attach: false });

    await act(async () => {
      await box.api.sendMessage("hi");
    });

    expect(box.api.error).toMatchObject({ code: "rate_limited", retryable: true });
  });

  test("an error event after the headers flushed reaches error and onError", async () => {
    const onError = vi.fn();
    fetchMock.mockResolvedValueOnce(
      streamed([
        { seq: 0, event: { type: "run-start", runId: "run_1" } },
        {
          seq: 1,
          event: {
            type: "error",
            error: { code: "provider_error", message: "upstream 500", retryable: true },
          },
        },
        { seq: 2, event: { type: "run-end", runId: "run_1", finishReason: "error" } },
      ]),
    );
    const { box } = mount({ attach: false, onError });

    await act(async () => {
      await box.api.sendMessage("hi");
    });

    expect(box.api.error).toMatchObject({ code: "provider_error" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("the next send clears it, so a retry does not have to", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("hi");
    });
    expect(box.api.status).toBe("error");

    await act(async () => {
      await box.api.sendMessage("hi again");
    });

    expect(box.api.error).toBeNull();
    expect(box.api.status).toBe("idle");
  });
});

describe("lifecycle", () => {
  test("onFinish fires once per completed message", async () => {
    const onFinish = vi.fn();
    const { box } = mount({ attach: false, onFinish });

    await act(async () => {
      await box.api.sendMessage("hi");
    });

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]![0]).toMatchObject({ id: "m1", finishReason: "stop" });
  });

  test("onAwaitingInput gets the pending calls", async () => {
    const onAwaitingInput = vi.fn();
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false, onAwaitingInput });

    await act(async () => {
      await box.api.sendMessage("hi");
    });

    expect(onAwaitingInput.mock.calls[0]![0]).toHaveLength(2);
  });

  test("unmount aborts the request in flight and sets no state after it", async () => {
    const run = controlled();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => run.abort());
      return run.response;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { box, unmount } = mount({ attach: false });

    await act(async () => {
      void box.api.sendMessage("hi");
    });
    await act(async () => {
      run.push(ANSWER[0]!, ANSWER[1]!);
      await Promise.resolve();
    });

    unmount();
    expect(signal!.aborted).toBe(true);

    // Frames that were already on the wire when the component went away.
    await act(async () => {
      try {
        run.push(ANSWER[2]!);
        run.close();
      } catch {
        // The stream is already errored by the abort; either way nothing may
        // reach React.
      }
      await Promise.resolve();
    });

    // React logs "update on an unmounted component" through console.error.
    expect(error).not.toHaveBeenCalled();
  });

  test("a second send supersedes the first rather than interleaving two answers", async () => {
    const first = controlled();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => first.abort());
      return first.response;
    });
    // A distinct run, whose frames number from zero again — which is exactly
    // the case the cursor has to be told about.
    fetchMock.mockImplementationOnce(async () =>
      streamed([
        { seq: 0, event: { type: "run-start", runId: "run_2", threadId: "th_9" } },
        { seq: 1, event: { type: "message-start", messageId: "m2", role: "assistant" } },
        { seq: 2, event: { type: "text-delta", messageId: "m2", delta: "Second." } },
        { seq: 3, event: { type: "message-end", messageId: "m2", finishReason: "stop" } },
        { seq: 4, event: { type: "run-end", runId: "run_2", finishReason: "stop" } },
      ]),
    );
    const { box } = mount({ attach: false });

    await act(async () => {
      void box.api.sendMessage("one");
    });
    await act(async () => {
      first.push(ANSWER[0]!, ANSWER[1]!, ANSWER[2]!);
      await Promise.resolve();
    });
    await act(async () => {
      await box.api.sendMessage("two");
    });

    // user, the interrupted assistant turn, user, the new answer.
    expect(box.api.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The interrupted turn keeps the text it had produced.
    expect(box.api.messages[1]!.content).toEqual([{ type: "text", text: "Hi there." }]);
    expect(box.api.messages[3]!.content).toEqual([{ type: "text", text: "Second." }]);
    // And says it was cut off. Left with no finish reason it is indistinguishable
    // from one still streaming, and run_2's `run-end` would sweep it up and call
    // it "stop" — telling the user, and in stateless mode the model on every
    // later turn, that an answer stopped mid-sentence ended cleanly.
    expect(box.api.messages.map((m) => m.finishReason)).toEqual([
      undefined,
      "aborted",
      undefined,
      "stop",
    ]);
    expect(box.api.status).toBe("idle");
  });

  test("the superseded turn goes back to a stateless server marked aborted", async () => {
    // The transcript the client carries is what the model is shown next time.
    const first = controlled();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init?.signal?.addEventListener("abort", () => first.abort());
      return first.response;
    });
    const anonymous = ANSWER.map((frame, index) =>
      index === 0 ? { seq: 0, event: { type: "run-start" as const, runId: "run_1" } } : frame,
    );
    fetchMock.mockImplementation(async () => streamed(anonymous));
    const { box } = mount({ attach: false });

    await act(async () => {
      void box.api.sendMessage("one");
    });
    await act(async () => {
      first.push({ seq: 0, event: { type: "run-start", runId: "run_0" } }, ANSWER[1]!, ANSWER[2]!);
      await Promise.resolve();
    });
    await act(async () => {
      await box.api.sendMessage("two");
    });

    expect(bodyOf(1).messages[1]).toMatchObject({ role: "assistant", finishReason: "aborted" });
  });
});

/**
 * A tool that ran a sub-agent, which asked a question of its own.
 *
 * The question reaches the user on the *parent's* `awaiting-input`, carrying
 * the path that says which tool call to re-enter. Everything below is about one
 * claim: an app cannot tell from its own code that this happened.
 */
const NESTED_ASK: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_3", threadId: "th_9" } },
  { seq: 1, event: { type: "message-start", messageId: "m3", role: "assistant" } },
  {
    seq: 2,
    event: {
      type: "tool-call",
      messageId: "m3",
      part: {
        type: "tool-call",
        toolCallId: "tc_outer",
        name: "research",
        input: { topic: "pricing" },
      },
    },
  },
  { seq: 3, event: { type: "tool-search", loaded: ["browse"] } },
  { seq: 4, event: { type: "tool-progress", toolCallId: "tc_outer", data: { stage: "starting" } } },
  {
    seq: 5,
    event: {
      type: "nested-event",
      toolCallId: "tc_outer",
      runId: "nr_1",
      agent: "pricing",
      label: "researching pricing",
      event: { type: "text-delta", messageId: "n1", delta: "I need the customer tier." },
    },
  },
  {
    seq: 6,
    event: {
      type: "awaiting-input",
      runId: "run_3",
      pending: [
        {
          toolCallId: "tc_inner",
          name: "ask",
          input: { question: "Which tier?" },
          kind: "question",
          signature: "sig_nested",
          path: ["tc_outer"],
        },
      ],
    },
  },
  { seq: 7, event: { type: "message-end", messageId: "m3", finishReason: "awaiting-input" } },
  { seq: 8, event: { type: "run-end", runId: "run_3", finishReason: "awaiting-input" } },
];

describe("a question from a sub-agent", () => {
  async function parked() {
    fetchMock.mockResolvedValueOnce(streamed(NESTED_ASK));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("what should we charge?");
    });
    return box;
  }

  test("is answered by the same answer() an app already writes", async () => {
    const box = await parked();

    await act(async () => {
      await box.api.answer("tc_inner", { answer: "enterprise" });
    });

    // The path goes back exactly as it arrived, beside the signature that
    // commits to it — the app wrote a tool call id and a value, and nothing
    // else, which is the whole point of doing it this way.
    expect(bodyOf(1).turn.toolResults).toEqual([
      {
        toolCallId: "tc_inner",
        signature: "sig_nested",
        path: ["tc_outer"],
        output: { answer: "enterprise" },
      },
    ]);
  });

  test("approve() carries the path too", async () => {
    const box = await parked();

    await act(async () => {
      await box.api.approve("tc_inner", false, "wrong customer");
    });

    expect(bodyOf(1).turn.toolResults).toEqual([
      {
        toolCallId: "tc_inner",
        signature: "sig_nested",
        path: ["tc_outer"],
        approve: false,
        reason: "wrong customer",
      },
    ]);
  });

  test("a top-level call still sends no path at all", async () => {
    // The absent path has to stay absent: `signing.ts` must produce the same
    // signature it produced before paths existed, or every open approval breaks.
    fetchMock.mockResolvedValueOnce(streamed(ASKING));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("refund me");
    });

    await act(async () => {
      await box.api.approve("tc_1", true);
    });

    expect(bodyOf(1).turn.toolResults).toEqual([
      { toolCallId: "tc_1", signature: "sig_one", approve: true },
    ]);
  });

  test("the UI can see where the question came from without needing to", async () => {
    const box = await parked();

    expect(box.api.status).toBe("awaiting-input");
    expect(box.api.pending[0]).toMatchObject({ toolCallId: "tc_inner", path: ["tc_outer"] });
  });

  test("two sub-runs holding the same tool call id are refused, not guessed at", async () => {
    // Reachable only through nesting: the ids come from whichever provider ran
    // each sub-run. `approve` is addressed by id alone on purpose, so when the
    // id stops being an address the honest answer is to say so rather than
    // approve whichever call sorted first.
    const collision = NESTED_ASK.map((frame) =>
      frame.seq === 6
        ? {
            seq: 6,
            event: {
              type: "awaiting-input" as const,
              runId: "run_3",
              pending: [
                (frame.event as { pending: unknown[] }).pending[0] as never,
                {
                  toolCallId: "tc_inner",
                  name: "ask",
                  input: { question: "Which region?" },
                  kind: "question" as const,
                  signature: "sig_other",
                  path: ["tc_second"],
                } as never,
              ],
            },
          }
        : frame,
    );
    fetchMock.mockResolvedValueOnce(streamed(collision));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("what should we charge?");
    });

    await act(async () => {
      await box.api.answer("tc_inner", { answer: "enterprise" });
    });

    expect(calls()).toHaveLength(1);
    expect(box.api.error).toMatchObject({ code: "invalid_tool_result", retryable: false });
    // Both are still answerable once the app disambiguates; nothing was thrown
    // away because one report was ambiguous.
    expect(box.api.pending).toHaveLength(2);
  });
});

describe("what a nested run leaves in the transcript", () => {
  test("the sub-run and the tool's own yields are on the tool call, ready to render", async () => {
    fetchMock.mockResolvedValueOnce(streamed(NESTED_ASK));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("what should we charge?");
    });

    const call = box.api.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-call") as {
      progress?: unknown[];
      nested?: { agent: string; label?: string; messages: unknown[] }[];
    };
    expect(call.progress).toEqual([{ stage: "starting" }]);
    expect(call.nested).toHaveLength(1);
    expect(call.nested![0]).toMatchObject({ agent: "pricing", label: "researching pricing" });
    expect(call.nested![0]!.messages).toEqual([
      {
        id: "n1",
        role: "assistant",
        content: [{ type: "text", text: "I need the customer tier." }],
        createdAt: expect.any(String),
        // Put there by the parent's `run-end`. This fixture never sends the
        // sub-run's own `message-end` — a real runtime would, since the
        // sub-agent finalises its message before escalating — and the point of
        // the safety net is that the block stops drawing a live cursor either
        // way. "awaiting-input" is what it is waiting for, and it is what the
        // parent message beside it carries.
        finishReason: "awaiting-input",
      },
    ]);
  });

  test("loadedTools names the deferred tools in play and empties on the next run", async () => {
    fetchMock.mockResolvedValueOnce(streamed(NESTED_ASK));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("what should we charge?");
    });

    expect(box.api.loadedTools).toEqual(["browse"]);

    fetchMock.mockResolvedValueOnce(streamed(ANSWER));
    await act(async () => {
      await box.api.sendMessage("never mind");
    });

    expect(box.api.loadedTools).toEqual([]);
  });
});

/**
 * A stateless run — no `threadId`, so the client carries the transcript — whose
 * tool yielded twice and whose sub-agent's own tool yielded once.
 */
const STATELESS_NESTED: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_5" } },
  { seq: 1, event: { type: "message-start", messageId: "m5", role: "assistant" } },
  {
    seq: 2,
    event: {
      type: "tool-call",
      messageId: "m5",
      part: {
        type: "tool-call",
        toolCallId: "tc_outer",
        name: "research",
        input: { topic: "pricing" },
      },
    },
  },
  { seq: 3, event: { type: "tool-progress", toolCallId: "tc_outer", data: { chunk: 1 } } },
  { seq: 4, event: { type: "tool-progress", toolCallId: "tc_outer", data: { chunk: 2 } } },
  {
    seq: 5,
    event: {
      type: "nested-event",
      toolCallId: "tc_outer",
      runId: "nr_1",
      agent: "pricing",
      event: { type: "message-start", messageId: "n1", role: "assistant" },
    },
  },
  {
    seq: 6,
    event: {
      type: "nested-event",
      toolCallId: "tc_outer",
      runId: "nr_1",
      agent: "pricing",
      event: {
        type: "tool-call",
        messageId: "n1",
        part: {
          type: "tool-call",
          toolCallId: "tc_inner",
          name: "browse",
          input: { url: "https://example.com" },
        },
      },
    },
  },
  {
    seq: 7,
    event: {
      type: "nested-event",
      toolCallId: "tc_outer",
      runId: "nr_1",
      agent: "pricing",
      event: { type: "tool-progress", toolCallId: "tc_inner", data: { page: 1 } },
    },
  },
  {
    seq: 8,
    event: {
      type: "nested-event",
      toolCallId: "tc_outer",
      runId: "nr_1",
      agent: "pricing",
      event: { type: "message-end", messageId: "n1", finishReason: "stop" },
    },
  },
  {
    seq: 9,
    event: {
      type: "tool-result",
      messageId: "m5",
      part: {
        type: "tool-result",
        toolCallId: "tc_outer",
        name: "research",
        status: "ok",
        output: { summary: "$40" },
      },
    },
  },
  { seq: 10, event: { type: "message-end", messageId: "m5", finishReason: "stop" } },
  { seq: 11, event: { type: "run-end", runId: "run_5", finishReason: "stop" } },
];

describe("the history a stateless turn posts back", () => {
  async function secondTurn() {
    fetchMock.mockResolvedValueOnce(streamed(STATELESS_NESTED));
    const { box } = mount({ attach: false });
    await act(async () => {
      await box.api.sendMessage("what should we charge?");
    });
    fetchMock.mockResolvedValueOnce(streamed(ANSWER));
    await act(async () => {
      await box.api.sendMessage("and for teams?");
    });
    const posted = bodyOf(1).messages as any[];
    return { box, call: posted[1].content.find((p: any) => p.type === "tool-call") };
  }

  test("leaves the progress logs behind, at every depth", async () => {
    // Every stateless turn re-uploads the whole transcript, and `progress` is
    // the one thing on it that grows without a bound the model imposes — a tool
    // yielding per chunk writes an entry per chunk, and turn 2, turn 3 and
    // every turn after would carry all of them. Nothing server-side reads it:
    // no provider translates it, `openCalls` matches on `toolCallId`, and the
    // resume path replays a sub-agent from `nested`.
    const { call } = await secondTurn();

    expect("progress" in call).toBe(false);
    const inner = call.nested[0].messages[0].content.find((p: any) => p.type === "tool-call");
    expect("progress" in inner).toBe(false);
  });

  test("keeps the nested transcript, which the resume path does read", async () => {
    // The asymmetry is the point: `nested` is how section D replays a finished
    // sub-run on the next turn, so stripping it would break resumption to save
    // the same bytes.
    const { call } = await secondTurn();

    expect(call.nested).toHaveLength(1);
    expect(call.nested[0]).toMatchObject({ runId: "nr_1", agent: "pricing" });
    expect(call.nested[0].messages[0]).toMatchObject({ id: "n1", finishReason: "stop" });
  });

  test("and the tab still has every yield it was shown", async () => {
    // The stripping shapes the request body, not the transcript: a UI rendering
    // the log must not lose it because a later turn was sent.
    const { box } = await secondTurn();
    const call = (box.api.messages[1]!.content as any[]).find((p) => p.type === "tool-call");

    expect(call.progress).toEqual([{ chunk: 1 }, { chunk: 2 }]);
    const inner = call.nested[0].messages[0].content.find((p: any) => p.type === "tool-call");
    expect(inner.progress).toEqual([{ page: 1 }]);
  });
});
