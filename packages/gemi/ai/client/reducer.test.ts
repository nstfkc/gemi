import { describe, expect, test } from "vitest";
import type { AgentMessage, AgentStreamFrame, NestedRun } from "../types";
import { applyFrame, initialChatState, markAborted, type ChatState } from "./reducer";

const NOW = "2026-09-02T00:00:00.000Z";

/**
 * One realistic run: the assistant says something, calls a tool (arguments
 * streaming in, so the call arrives twice), gets a result, says something else,
 * then parks on a question.
 */
const RUN: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_1", threadId: "th_1" } },
  { seq: 1, event: { type: "message-start", messageId: "m1", role: "assistant" } },
  { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "Let me look." } },
  {
    seq: 3,
    event: {
      type: "tool-call",
      messageId: "m1",
      part: {
        type: "tool-call",
        toolCallId: "tc_1",
        name: "grep",
        input: { pattern: "TODO" },
        partial: true,
      },
    },
  },
  {
    seq: 4,
    event: {
      type: "tool-call",
      messageId: "m1",
      part: {
        type: "tool-call",
        toolCallId: "tc_1",
        name: "grep",
        input: { pattern: "TODO", filePath: "a.ts" },
      },
    },
  },
  {
    seq: 5,
    event: {
      type: "tool-result",
      messageId: "m1",
      part: {
        type: "tool-result",
        toolCallId: "tc_1",
        name: "grep",
        status: "ok",
        output: { matches: ["a.ts:1"] },
      },
    },
  },
  { seq: 6, event: { type: "text-delta", messageId: "m1", delta: " Found one." } },
  {
    seq: 7,
    event: {
      type: "awaiting-input",
      runId: "run_1",
      pending: [
        {
          toolCallId: "tc_2",
          name: "ask",
          input: { question: "Which file?" },
          kind: "question",
          signature: "sig_2",
        },
      ],
    },
  },
  {
    seq: 8,
    event: {
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    },
  },
  { seq: 9, event: { type: "message-end", messageId: "m1", finishReason: "awaiting-input" } },
  { seq: 10, event: { type: "run-end", runId: "run_1", finishReason: "awaiting-input" } },
];

function fold(state: ChatState, frames: AgentStreamFrame[]) {
  return frames.reduce((acc, frame) => applyFrame(acc, frame, NOW), state);
}

function at(upTo: number) {
  return fold(initialChatState(), RUN.slice(0, upTo + 1));
}

describe("applyFrame over a run", () => {
  test("run-start records the ids and nothing else", () => {
    const state = at(0);

    expect(state).toMatchObject({ runId: "run_1", threadId: "th_1", messages: [], seq: 0 });
  });

  test("message-start opens an empty assistant message", () => {
    expect(at(1).messages).toEqual([{ id: "m1", role: "assistant", content: [], createdAt: NOW }]);
  });

  test("text deltas coalesce into one part", () => {
    const state = fold(at(1), [
      { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "ab" } },
      { seq: 3, event: { type: "text-delta", messageId: "m1", delta: "cd" } },
    ]);

    expect(state.messages[0]!.content).toEqual([{ type: "text", text: "abcd" }]);
  });

  test("a re-streamed tool call replaces the partial one instead of appearing twice", () => {
    const state = at(4);

    expect(state.messages[0]!.content).toEqual([
      { type: "text", text: "Let me look." },
      {
        type: "tool-call",
        toolCallId: "tc_1",
        name: "grep",
        input: { pattern: "TODO", filePath: "a.ts" },
      },
    ]);
  });

  test("a tool result lands next to its call", () => {
    const content = at(5).messages[0]!.content;

    expect(content).toHaveLength(3);
    expect(content[2]).toMatchObject({ type: "tool-result", toolCallId: "tc_1", status: "ok" });
  });

  test("text after a tool call opens a new part rather than merging backwards", () => {
    const content = at(6).messages[0]!.content;

    expect(content.map((part) => part.type)).toEqual(["text", "tool-call", "tool-result", "text"]);
    expect(content[3]).toEqual({ type: "text", text: " Found one." });
  });

  test("awaiting-input parks the run with the pending call", () => {
    const state = at(7);

    expect(state.pending).toEqual([
      {
        toolCallId: "tc_2",
        name: "ask",
        input: { question: "Which file?" },
        kind: "question",
        signature: "sig_2",
      },
    ]);
    expect(state.runId).toBe("run_1");
  });

  test("usage attaches to the message that just ended", () => {
    expect(at(8).messages[0]!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
  });

  test("message-end stamps the finish reason", () => {
    expect(at(9).messages[0]!.finishReason).toBe("awaiting-input");
  });

  test("run-end clears the run but keeps the question", () => {
    const state = at(10);

    expect(state.runId).toBeUndefined();
    expect(state.finishReason).toBe("awaiting-input");
    expect(state.pending).toHaveLength(1);
    expect(state.seq).toBe(10);
  });
});

describe("replay", () => {
  test("applying the whole run twice changes nothing", () => {
    const once = fold(initialChatState(), RUN);
    const twice = fold(once, RUN);

    // Identity, not just equality: `applyFrame` returns the state it was given
    // when the frame is at or below the cursor, and the hook reads that to know
    // it must not fire `onFinish` a second time.
    expect(twice).toBe(once);
  });

  test("a single redelivered delta does not append its text twice", () => {
    const state = at(2);
    const again = applyFrame(state, RUN[2]!, NOW);

    expect(again.messages[0]!.content).toEqual([{ type: "text", text: "Let me look." }]);
  });

  test("resuming from any mid-run cursor converges on the same conversation", () => {
    const full = fold(initialChatState(), RUN);

    for (let cursor = 0; cursor < RUN.length - 1; cursor++) {
      // What a client actually has after a refresh: its messages, the question
      // it was holding, the thread, and how far it got. Not `runId` — that is
      // the server's to hand back, which is why `/attach` is asked by thread.
      const dropped = at(cursor);
      const resumed = initialChatState({
        messages: dropped.messages,
        pending: dropped.pending,
        threadId: dropped.threadId,
        seq: dropped.seq,
      });

      const caughtUp = fold(resumed, RUN.slice(cursor + 1));

      expect(caughtUp.messages, `resumed at ${cursor}`).toEqual(full.messages);
      expect(caughtUp.pending, `resumed at ${cursor}`).toEqual(full.pending);
      expect(caughtUp.threadId, `resumed at ${cursor}`).toEqual(full.threadId);
      expect(caughtUp.seq, `resumed at ${cursor}`).toBe(full.seq);
    }
  });

  test("a second run restarts the numbering and is not swallowed by the cursor", () => {
    // The ordinary second turn of a conversation. Every frame of run_2 is at or
    // below the cursor run_1 left behind, so without the run-start exemption the
    // whole answer reads as already-applied.
    const first = fold(initialChatState(), RUN);
    const second = fold(first, [
      { seq: 0, event: { type: "run-start", runId: "run_2", threadId: "th_1" } },
      { seq: 1, event: { type: "message-start", messageId: "m2", role: "assistant" } },
      { seq: 2, event: { type: "text-delta", messageId: "m2", delta: "second answer" } },
      { seq: 3, event: { type: "run-end", runId: "run_2", finishReason: "stop" } },
    ]);

    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]!.content).toEqual([{ type: "text", text: "second answer" }]);
  });

  test("a redelivered run-start for the run in hand still dedupes", () => {
    const state = at(2);
    const again = applyFrame(state, RUN[0]!, NOW);

    expect(again).toBe(state);
  });

  test("a run replayed onto a transcript that already has it does not double the text", () => {
    // A restored client whose cursor was lost (or ignored) asks `/attach` and is
    // handed the whole run back. Every frame is new to the cursor — it is -1 —
    // so `seq` cannot help; the finished message is the only evidence that this
    // is replay, and it is enough.
    const restored = initialChatState({
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: NOW },
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "Let me look. Found one." }],
          createdAt: NOW,
          finishReason: "awaiting-input",
        },
      ],
    });

    const replayed = fold(restored, RUN);

    expect(replayed.messages).toHaveLength(2);
    expect(replayed.messages[1]!.content).toEqual([
      { type: "text", text: "Let me look. Found one." },
      // The upserts still land — they are keyed, so applying them again is the
      // same list. Only the additive deltas are refused.
      expect.objectContaining({ type: "tool-call", toolCallId: "tc_1" }),
      expect.objectContaining({ type: "tool-result", toolCallId: "tc_1" }),
    ]);
  });

  test("a reasoning delta for a finished message is refused too", () => {
    const finished = fold(initialChatState(), [
      { seq: 0, event: { type: "reasoning-delta", messageId: "m1", delta: "hm" } },
      { seq: 1, event: { type: "message-end", messageId: "m1", finishReason: "stop" } },
    ]);

    const replayed = fold(finished, [
      { seq: 0, event: { type: "run-start", runId: "run_9" } },
      { seq: 1, event: { type: "reasoning-delta", messageId: "m1", delta: "hm" } },
    ]);

    expect(replayed.messages[0]!.content).toEqual([{ type: "reasoning", text: "hm" }]);
  });

  test("a client handed only the tail builds the message it never saw start", () => {
    // The `/attach` case with nothing kept: no run-start, no message-start, and
    // the first frame is already halfway through m1. A reducer that assumed it
    // saw frame 1 drops all of this on the floor.
    const state = fold(initialChatState(), RUN.slice(5));

    expect(state.messages).toHaveLength(1);
    const message = state.messages[0]!;
    expect(message.id).toBe("m1");
    expect(message.role).toBe("assistant");
    expect(message.content.map((part) => part.type)).toEqual(["tool-result", "text"]);
    expect(message.finishReason).toBe("awaiting-input");
    expect(state.pending).toHaveLength(1);
  });
});

describe("the rest of the event union", () => {
  test("reasoning is its own part and does not merge into text", () => {
    const state = fold(initialChatState(), [
      { seq: 0, event: { type: "reasoning-delta", messageId: "m1", delta: "hm" } },
      { seq: 1, event: { type: "reasoning-delta", messageId: "m1", delta: "mm" } },
      { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "answer" } },
    ]);

    expect(state.messages[0]!.content).toEqual([
      { type: "reasoning", text: "hmmm" },
      { type: "text", text: "answer" },
    ]);
  });

  test("output snapshots replace rather than accumulate, so a late client is right", () => {
    const late = fold(initialChatState(), [
      {
        seq: 4,
        event: {
          type: "output-delta",
          messageId: "m1",
          delta: '"neutral"}',
          snapshot: { sentiment: "neutral" },
        },
      },
      { seq: 5, event: { type: "message-end", messageId: "m1", finishReason: "stop" } },
    ]);

    expect(late.messages[0]!.content).toEqual([
      { type: "output", value: { sentiment: "neutral" }, partial: false },
    ]);
  });

  test("an error clears pending, so awaiting-input cannot be true alongside it", () => {
    const state = fold(at(7), [
      {
        seq: 8,
        event: {
          type: "error",
          error: { code: "provider_error", message: "upstream 500", retryable: true },
        },
      },
    ]);

    expect(state.error).toEqual({
      code: "provider_error",
      message: "upstream 500",
      retryable: true,
    });
    expect(state.pending).toEqual([]);
  });

  test("a tool result for a pending call resolves it", () => {
    const state = fold(at(7), [
      {
        seq: 8,
        event: {
          type: "tool-result",
          messageId: "m1",
          part: {
            type: "tool-result",
            toolCallId: "tc_2",
            name: "ask",
            status: "ok",
            output: { answer: "a.ts" },
          },
        },
      },
    ]);

    expect(state.pending).toEqual([]);
  });

  test("run-end ends a message whose message-end was never seen", () => {
    const state = fold(initialChatState(), [
      { seq: 20, event: { type: "text-delta", messageId: "m9", delta: "half" } },
      { seq: 21, event: { type: "run-end", runId: "run_1", finishReason: "aborted" } },
    ]);

    // Otherwise the message renders a cursor for the rest of the session.
    expect(state.messages[0]!.finishReason).toBe("aborted");
  });

  test("run-end finishes off this run's messages and leaves an earlier one's alone", () => {
    // A superseded turn: run_1's answer was cut off mid-sentence and never got a
    // `message-end`, so it is sitting there with no finish reason. When run_2
    // ends cleanly, "every assistant message with no finish reason" would sweep
    // it up and label an interrupted answer a completed one — which is then what
    // the next stateless turn tells the model happened.
    const interrupted = fold(initialChatState(), [
      { seq: 0, event: { type: "run-start", runId: "run_1" } },
      { seq: 1, event: { type: "message-start", messageId: "m1", role: "assistant" } },
      { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "Half a sen" } },
    ]);

    const after = fold(interrupted, [
      { seq: 0, event: { type: "run-start", runId: "run_2" } },
      { seq: 1, event: { type: "message-start", messageId: "m2", role: "assistant" } },
      { seq: 2, event: { type: "text-delta", messageId: "m2", delta: "A whole one." } },
      { seq: 3, event: { type: "run-end", runId: "run_2", finishReason: "stop" } },
    ]);

    expect(after.messages.map((message) => message.finishReason)).toEqual([undefined, "stop"]);
  });

  test("usage with no assistant message of its own is dropped, not put on the user's turn", () => {
    // A run that errors after the provider counted input tokens, or one whose
    // only output is a tool call the client has to resolve, emits `usage` while
    // the last message is still the optimistic user turn. Token counts against
    // what the user typed are simply false.
    const user: AgentMessage = {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: NOW,
    };
    const state = fold(initialChatState({ messages: [user] }), [
      { seq: 0, event: { type: "run-start", runId: "run_1" } },
      {
        seq: 1,
        event: { type: "usage", usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 } },
      },
      { seq: 2, event: { type: "run-end", runId: "run_1", finishReason: "error" } },
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.usage).toBeUndefined();
  });

  test("tool-search names the tools in play without touching the transcript", () => {
    const before = at(6);
    const after = fold(before, [
      { seq: 7, event: { type: "tool-search", loaded: ["refundOrder"] } },
      { seq: 8, event: { type: "tool-search", loaded: ["refundOrder", "listOrders"] } },
    ]);

    // A set, so the second search — which reports everything loaded so far, and
    // which a reattached client may be handed twice — adds one name, not three.
    expect(after.loadedTools).toEqual(["refundOrder", "listOrders"]);
    expect(after.messages).toEqual(before.messages);
    expect(after.seq).toBe(8);
  });

  test("tool-search is run-scoped, so the next turn does not inherit it", () => {
    const state = fold(at(6), [
      { seq: 7, event: { type: "tool-search", loaded: ["refundOrder"] } },
      { seq: 8, event: { type: "run-end", runId: "run_1", finishReason: "stop" } },
      { seq: 0, event: { type: "run-start", runId: "run_2" } },
    ]);

    expect(state.loadedTools).toEqual([]);
  });
});

describe("markAborted", () => {
  test("keeps the interrupted turn and marks it cut short", () => {
    const state = markAborted(at(6));

    expect(state.messages[0]!.content).toHaveLength(4);
    expect(state.messages[0]!.finishReason).toBe("aborted");
    expect(state.runId).toBeUndefined();
  });

  test("does not rewrite a message that already finished", () => {
    const finished = fold(initialChatState(), [
      { seq: 0, event: { type: "text-delta", messageId: "m1", delta: "done" } },
      { seq: 1, event: { type: "message-end", messageId: "m1", finishReason: "stop" } },
    ]);

    expect(markAborted(finished).messages[0]!.finishReason).toBe("stop");
  });

  test("leaves a question standing: stopping a run does not answer it", () => {
    const state = markAborted(at(7));

    expect(state.pending).toHaveLength(1);
  });

  test("only the run in hand is cut short, not an older unfinished turn", () => {
    // A restored transcript can legitimately carry an assistant message with no
    // finish reason — the interrupted turn a previous session kept. Stopping
    // today's run is not a statement about it.
    const stale: AgentMessage = {
      id: "old",
      role: "assistant",
      content: [{ type: "text", text: "from last time" }],
      createdAt: NOW,
    };
    const state = markAborted(
      fold(initialChatState({ messages: [stale] }), [
        { seq: 0, event: { type: "run-start", runId: "run_1" } },
        { seq: 1, event: { type: "text-delta", messageId: "m1", delta: "today" } },
      ]),
    );

    expect(state.messages.map((message) => message.finishReason)).toEqual([undefined, "aborted"]);
  });

  test("a user turn is never stamped with a finish reason", () => {
    const user: AgentMessage = {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: NOW,
    };
    const state = markAborted(initialChatState({ messages: [user] }));

    expect(state.messages[0]!.finishReason).toBeUndefined();
  });
});

/**
 * One tool that runs a sub-agent, on the wire.
 *
 * `tc_1` is the parent's tool call; `nr_1` is the sub-run it drove. Every
 * sub-run frame is a `nested-event` on the *parent's* stream, numbered in the
 * parent's `seq` — which is what lets `/attach` and the cursor keep working
 * through the nesting, and what means nothing below needs a second cursor.
 */
const NESTED: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_1", threadId: "th_1" } },
  { seq: 1, event: { type: "message-start", messageId: "m1", role: "assistant" } },
  { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "Looking into it." } },
  {
    seq: 3,
    event: {
      type: "tool-call",
      messageId: "m1",
      part: {
        type: "tool-call",
        toolCallId: "tc_1",
        name: "research",
        input: { topic: "pricing" },
      },
    },
  },
  { seq: 4, event: { type: "tool-progress", toolCallId: "tc_1", data: { stage: "starting" } } },
  { seq: 5, event: nested({ type: "run-start", runId: "nr_1" }) },
  { seq: 6, event: nested({ type: "message-start", messageId: "n1", role: "assistant" }) },
  { seq: 7, event: nested({ type: "text-delta", messageId: "n1", delta: "The list price is " }) },
  { seq: 8, event: nested({ type: "text-delta", messageId: "n1", delta: "$40." }) },
  { seq: 9, event: nested({ type: "message-end", messageId: "n1", finishReason: "stop" }) },
  {
    seq: 10,
    event: nested({
      type: "usage",
      usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
    }),
  },
  { seq: 11, event: nested({ type: "run-end", runId: "nr_1", finishReason: "stop" }) },
  { seq: 12, event: { type: "tool-progress", toolCallId: "tc_1", data: { stage: "summarising" } } },
  {
    seq: 13,
    event: {
      type: "tool-result",
      messageId: "m1",
      part: {
        type: "tool-result",
        toolCallId: "tc_1",
        name: "research",
        status: "ok",
        output: { summary: "$40" },
      },
    },
  },
  { seq: 14, event: { type: "text-delta", messageId: "m1", delta: " It is $40." } },
  { seq: 15, event: { type: "message-end", messageId: "m1", finishReason: "stop" } },
  { seq: 16, event: { type: "run-end", runId: "run_1", finishReason: "stop" } },
];

/** The wrapper every sub-run frame arrives in, so the fixture reads as a run. */
function nested(
  event: AgentStreamFrame["event"],
  wrap: { toolCallId?: string; runId?: string; agent?: string; label?: string } = {},
): AgentStreamFrame["event"] {
  return {
    type: "nested-event",
    toolCallId: wrap.toolCallId ?? "tc_1",
    runId: wrap.runId ?? "nr_1",
    agent: wrap.agent ?? "pricing",
    label: wrap.label ?? "researching pricing",
    event,
  };
}

function runOf(state: ChatState, toolCallId = "tc_1", index = 0) {
  for (const message of state.messages) {
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) {
        return part.nested?.[index];
      }
    }
  }
  return undefined;
}

function callOf(state: ChatState, toolCallId = "tc_1") {
  for (const message of state.messages) {
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

/**
 * The two ways nesting can violate the reducer's contract, first.
 *
 * Both are shapes of the same thing — a client handed the middle of a run —
 * and both are the reason the happy-path tests below are not enough on their
 * own.
 */
describe("nesting tolerates a stream it joined late", () => {
  test("a nested-event for a tool call this client never saw is dropped, not crashed", () => {
    // The mid-run `/attach` with nothing kept: the `tool-call` frame that would
    // have created `tc_1` is at seq 3, below where this client joined, and it is
    // never re-sent. There is no honest place to put the sub-run — a
    // `ToolCallPart` invented here would need a tool name and an input that no
    // nested frame carries — so the run is lost and the transcript stays true.
    const state = fold(initialChatState(), NESTED.slice(5, 12));

    expect(state.messages).toEqual([]);
    expect(state.error).toBeNull();
    // The cursor still advances, which is the part that must not break: the
    // frames after these describe messages this client *can* build.
    expect(state.seq).toBe(11);
  });

  test("the run continues normally after the orphaned nested frames", () => {
    const state = fold(initialChatState(), NESTED.slice(5));

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content.map((part) => part.type)).toEqual([
      "tool-result",
      "text",
    ]);
    expect(state.finishReason).toBe("stop");
  });

  test("a nested run whose own message-start never arrived builds the message anyway", () => {
    // The sub-run joined halfway too. The recursion means this needs no code of
    // its own — `withMessage` creates a message it never saw start, and it does
    // that inside a nested transcript for the same reason it does it outside.
    const state = fold(at3(), [
      { seq: 4, event: nested({ type: "text-delta", messageId: "n1", delta: "half a thought" }) },
    ]);

    expect(runOf(state)!.messages).toEqual([
      {
        id: "n1",
        role: "assistant",
        content: [{ type: "text", text: "half a thought" }],
        createdAt: NOW,
      },
    ]);
  });

  test("a nested run whose run-start never arrived is still labelled", () => {
    // `agent` and `label` ride on every nested frame, not just the first, so a
    // sub-run created from its tail still has something to render as a heading.
    const state = fold(at3(), [
      { seq: 4, event: nested({ type: "text-delta", messageId: "n1", delta: "…" }) },
    ]);

    expect(runOf(state)).toMatchObject({
      runId: "nr_1",
      agent: "pricing",
      label: "researching pricing",
    });
  });
});

/** The parent up to and including the tool call, which is all nesting needs. */
function at3() {
  return fold(initialChatState(), NESTED.slice(0, 4));
}

describe("a tool that runs a sub-agent", () => {
  test("the sub-run's transcript lands on the tool call that drove it", () => {
    const state = fold(initialChatState(), NESTED);

    expect(runOf(state)).toEqual({
      runId: "nr_1",
      agent: "pricing",
      label: "researching pricing",
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
      messages: [
        {
          id: "n1",
          role: "assistant",
          content: [{ type: "text", text: "The list price is $40." }],
          createdAt: NOW,
          finishReason: "stop",
          usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
        },
      ],
    });
  });

  test("a nested message is the shape of a top-level one, so one renderer does both", () => {
    // The claim the whole design rests on. `render` below stands in for a
    // component: it is written once, against `AgentMessage[]`, and it is handed
    // the outer transcript and then the inner one with no second code path and
    // nothing that knows a sub-agent exists.
    const state = fold(initialChatState(), NESTED);
    const render = (messages: AgentMessage[]) =>
      messages.map(
        (message) =>
          `${message.role}: ${message.content
            .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
            .join("")}`,
      );

    expect(render(state.messages)).toEqual([
      "assistant: Looking into it.[tool-call][tool-result] It is $40.",
    ]);
    expect(render(runOf(state)!.messages)).toEqual(["assistant: The list price is $40."]);
  });

  test("the tool's own yields accumulate in order beside the sub-run", () => {
    const state = fold(initialChatState(), NESTED);

    expect(callOf(state)!.progress).toEqual([{ stage: "starting" }, { stage: "summarising" }]);
  });

  test("a tool call with no sub-agent and no yields grows no fields", () => {
    const state = fold(initialChatState(), RUN);

    expect(callOf(state, "tc_1")).toEqual({
      type: "tool-call",
      toolCallId: "tc_1",
      name: "grep",
      input: { pattern: "TODO", filePath: "a.ts" },
    });
  });

  test("the parent transcript is unchanged by the nesting", () => {
    const state = fold(initialChatState(), NESTED);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-result",
      "text",
    ]);
    expect(state.messages[0]!.finishReason).toBe("stop");
  });

  test("two sub-runs under one tool call stay separate, in the order they started", () => {
    const state = fold(at3(), [
      { seq: 4, event: nested({ type: "text-delta", messageId: "n1", delta: "one" }) },
      {
        seq: 5,
        event: nested({ type: "text-delta", messageId: "n2", delta: "two" }, {
          runId: "nr_2",
          agent: "legal",
          label: "checking terms",
        }),
      },
      { seq: 6, event: nested({ type: "text-delta", messageId: "n1", delta: "!" }) },
    ]);

    const runs = callOf(state)!.nested!;
    expect(runs.map((run) => run.runId)).toEqual(["nr_1", "nr_2"]);
    expect(runs[0]!.messages[0]!.content).toEqual([{ type: "text", text: "one!" }]);
    expect(runs[1]!.agent).toBe("legal");
  });
});

describe("nesting keeps the reducer's contract", () => {
  test("applying the whole nested run twice changes nothing", () => {
    const once = fold(initialChatState(), NESTED);
    const twice = fold(once, NESTED);

    expect(twice).toBe(once);
  });

  test("a redelivered nested text-delta does not append its text twice", () => {
    const state = fold(initialChatState(), NESTED.slice(0, 8));
    const again = applyFrame(state, NESTED[7]!, NOW);

    expect(again).toBe(state);
    expect(runOf(state)!.messages[0]!.content).toEqual([
      { type: "text", text: "The list price is " },
    ]);
  });

  test("a redelivered tool-progress does not log the same yield twice", () => {
    const state = fold(initialChatState(), NESTED.slice(0, 5));
    const again = applyFrame(state, NESTED[4]!, NOW);

    expect(again).toBe(state);
    expect(callOf(state)!.progress).toEqual([{ stage: "starting" }]);
  });

  test("a whole run replayed onto a transcript that already holds it doubles nothing", () => {
    // The case `seq` cannot catch: the cursor was lost, so every frame is new to
    // it. The finished parent message is the only evidence this is replay, and
    // it has to protect the nested transcript and the progress log as well as
    // the text.
    const done = fold(initialChatState(), NESTED);
    const restored = initialChatState({ messages: done.messages });

    const replayed = fold(restored, NESTED);

    expect(callOf(replayed)!.progress).toEqual([{ stage: "starting" }, { stage: "summarising" }]);
    expect(callOf(replayed)!.nested).toHaveLength(1);
    expect(runOf(replayed)!.messages[0]!.content).toEqual([
      { type: "text", text: "The list price is $40." },
    ]);
  });

  test("a re-sent tool-call frame does not wipe what execution put on the part", () => {
    // The bug this file's upsert had until nesting made it visible: a
    // `tool-call` is the model's half of the part, and replacing the whole part
    // with it throws away the sub-run and the progress log — which arrive on
    // events that name no message and so can never be re-derived.
    const state = fold(initialChatState(), NESTED.slice(0, 12));
    const resent = applyFrame(state, { seq: 99, event: NESTED[3]!.event }, NOW);

    expect(callOf(resent)!.progress).toEqual([{ stage: "starting" }]);
    expect(runOf(resent)!.messages[0]!.content).toEqual([
      { type: "text", text: "The list price is $40." },
    ]);
  });

  test("a sub-run's own pending call does not become the parent's", () => {
    // An escalated question reaches the user on the parent's `awaiting-input`,
    // carrying the path that says which tool to re-enter. The copy inside the
    // sub-run's stream carries no path, so surfacing it here would show the
    // question twice and make one of the two unanswerable.
    const state = fold(at3(), [
      {
        seq: 4,
        event: nested({
          type: "awaiting-input",
          runId: "nr_1",
          pending: [
            {
              toolCallId: "tc_inner",
              name: "ask",
              input: { question: "Which tier?" },
              kind: "question",
              signature: "sig_inner",
            },
          ],
        }),
      },
    ]);

    expect(state.pending).toEqual([]);
  });

  test("resuming from any mid-run cursor converges on the same conversation", () => {
    const full = fold(initialChatState(), NESTED);

    for (let cursor = 0; cursor < NESTED.length - 1; cursor++) {
      const dropped = fold(initialChatState(), NESTED.slice(0, cursor + 1));
      const resumed = initialChatState({
        messages: dropped.messages,
        pending: dropped.pending,
        threadId: dropped.threadId,
        seq: dropped.seq,
      });

      const caughtUp = fold(resumed, NESTED.slice(cursor + 1));

      expect(caughtUp.messages, `resumed at ${cursor}`).toEqual(full.messages);
      expect(caughtUp.seq, `resumed at ${cursor}`).toBe(full.seq);
    }
  });
});

describe("nesting two levels deep", () => {
  /**
   * `tc_1` runs the pricing agent, whose own tool `tc_9` runs a web agent. The
   * inner frames are a `nested-event` wrapped in a `nested-event`, which is the
   * whole of what depth costs: the second one lands back in the same branch of
   * the same switch, one message list further down.
   */
  const DEEP: AgentStreamFrame[] = [
    ...NESTED.slice(0, 4),
    { seq: 4, event: nested({ type: "message-start", messageId: "n1", role: "assistant" }) },
    {
      seq: 5,
      event: nested({
        type: "tool-call",
        messageId: "n1",
        part: {
          type: "tool-call",
          toolCallId: "tc_9",
          name: "browse",
          input: { url: "https://example.com/pricing" },
        },
      }),
    },
    {
      seq: 6,
      event: nested(
        nested({ type: "message-start", messageId: "d1", role: "assistant" }, {
          toolCallId: "tc_9",
          runId: "nr_2",
          agent: "web",
          label: "reading the pricing page",
        }),
      ),
    },
    {
      seq: 7,
      event: nested(
        nested({ type: "text-delta", messageId: "d1", delta: "$40 a seat." }, {
          toolCallId: "tc_9",
          runId: "nr_2",
          agent: "web",
          label: "reading the pricing page",
        }),
      ),
    },
    {
      seq: 8,
      event: nested(
        nested({ type: "run-end", runId: "nr_2", finishReason: "stop" }, {
          toolCallId: "tc_9",
          runId: "nr_2",
          agent: "web",
          label: "reading the pricing page",
        }),
      ),
    },
  ];

  function inner(state: ChatState) {
    const outer = runOf(state)!;
    const call = outer.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-call" && part.toolCallId === "tc_9");
    return (call as { nested?: NestedRun[] }).nested![0]!;
  }

  test("the sub-sub-run lands on the sub-run's own tool call", () => {
    const state = fold(initialChatState(), DEEP);

    expect(inner(state)).toEqual({
      runId: "nr_2",
      agent: "web",
      label: "reading the pricing page",
      finishReason: "stop",
      messages: [
        {
          id: "d1",
          role: "assistant",
          content: [{ type: "text", text: "$40 a seat." }],
          createdAt: NOW,
          // The nested `run-end` closed off a message whose `message-end` never
          // came, two levels down, with no code that knows about depth.
          finishReason: "stop",
        },
      ],
    });
  });

  test("depth costs the contract nothing: replay and a mid-run cursor still converge", () => {
    const full = fold(initialChatState(), DEEP);

    expect(fold(full, DEEP)).toBe(full);

    for (let cursor = 0; cursor < DEEP.length - 1; cursor++) {
      const dropped = fold(initialChatState(), DEEP.slice(0, cursor + 1));
      const resumed = initialChatState({ messages: dropped.messages, seq: dropped.seq });

      expect(fold(resumed, DEEP.slice(cursor + 1)).messages, `resumed at ${cursor}`).toEqual(
        full.messages,
      );
    }
  });
});

/**
 * The resume turn, which is the reason nesting exists and the one shape no
 * single-turn fixture can produce.
 *
 * `Agent.loop` finalises the message **before** the run parks — `finalizeMessage
 * ("awaiting-input")` then `emit({ type: "awaiting-input" })` — so by the time
 * the user answers, the message holding the escalating tool call already carries
 * a finish reason. The next turn re-enters that same call (`resolveAnswer` runs
 * `executeTool` against the call it found in the history) and its progress and
 * sub-run frames arrive against that finished message.
 */
const PARKED: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_1", threadId: "th_1" } },
  { seq: 1, event: { type: "message-start", messageId: "m1", role: "assistant" } },
  {
    seq: 2,
    event: {
      type: "tool-call",
      messageId: "m1",
      part: {
        type: "tool-call",
        toolCallId: "tc_1",
        name: "research",
        input: { topic: "pricing" },
      },
    },
  },
  { seq: 3, event: { type: "message-end", messageId: "m1", finishReason: "awaiting-input" } },
  {
    seq: 4,
    event: {
      type: "awaiting-input",
      runId: "run_1",
      pending: [
        {
          toolCallId: "tc_inner",
          name: "ask",
          input: { question: "Which tier?" },
          kind: "question",
          signature: "sig_inner",
          path: ["tc_1"],
        },
      ],
    },
  },
  { seq: 5, event: { type: "run-end", runId: "run_1", finishReason: "awaiting-input" } },
];

/** The turn that answers it: the tool runs again, this time to completion. */
const RESUMED: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_2", threadId: "th_1" } },
  { seq: 1, event: { type: "tool-progress", toolCallId: "tc_1", data: { stage: "resuming" } } },
  { seq: 2, event: nested({ type: "message-start", messageId: "n1", role: "assistant" }) },
  { seq: 3, event: nested({ type: "text-delta", messageId: "n1", delta: "The pro tier is $80." }) },
  { seq: 4, event: nested({ type: "message-end", messageId: "n1", finishReason: "stop" }) },
  { seq: 5, event: nested({ type: "run-end", runId: "nr_1", finishReason: "stop" }) },
  {
    seq: 6,
    event: {
      type: "tool-result",
      messageId: "m1",
      part: {
        type: "tool-result",
        toolCallId: "tc_1",
        name: "research",
        status: "ok",
        output: { summary: "$80" },
      },
    },
  },
  { seq: 7, event: { type: "message-start", messageId: "m2", role: "assistant" } },
  { seq: 8, event: { type: "text-delta", messageId: "m2", delta: "It is $80." } },
  { seq: 9, event: { type: "message-end", messageId: "m2", finishReason: "stop" } },
  { seq: 10, event: { type: "run-end", runId: "run_2", finishReason: "stop" } },
];

describe("the turn that answers a sub-agent's question", () => {
  test("the re-entered tool still reports, though its message closed last turn", () => {
    // The bug: the finished-message replay guard fired on every resume, so the
    // whole second execution was dropped while its `tool-result` — which goes
    // through `withMessage`, unguarded — still landed. The user watched the call
    // go silent and then produce an answer, which is the exact failure nesting
    // was built to fix.
    const state = fold(fold(initialChatState(), PARKED), RESUMED);

    expect(callOf(state)!.progress).toEqual([{ stage: "resuming" }]);
    expect(runOf(state)!.messages[0]!.content).toEqual([
      { type: "text", text: "The pro tier is $80." },
    ]);
    expect(runOf(state)!.finishReason).toBe("stop");
  });

  test("the sub-run is recorded, which is what the next turn replays it from", () => {
    // Not cosmetic. `useChat.send` posts `messages` verbatim in stateless mode
    // and section D resumes a sub-agent from `ToolCallPart.nested`, so a
    // continuation the client never recorded is a sub-run that, to the next
    // turn, never finished.
    const state = fold(fold(initialChatState(), PARKED), RESUMED);
    const posted = fold(initialChatState({ messages: state.messages }), []);

    expect(runOf(posted)).toMatchObject({ runId: "nr_1", finishReason: "stop" });
  });

  test("a second parked call reports too, after the first one's result has landed", () => {
    // `ingestTurn` resolves the answers one at a time, attaching each result
    // before it starts the next tool — so the second call's progress arrives
    // once the message has already been written to by this run. Anything that
    // decided "replay" from the run having touched the message would drop it.
    const twoCalls = fold(initialChatState(), [
      ...PARKED.slice(0, 3),
      {
        seq: 3,
        event: {
          type: "tool-call",
          messageId: "m1",
          part: { type: "tool-call", toolCallId: "tc_2", name: "book", input: { seats: 2 } },
        },
      },
      { seq: 4, event: { type: "message-end", messageId: "m1", finishReason: "awaiting-input" } },
      { seq: 5, event: { type: "run-end", runId: "run_1", finishReason: "awaiting-input" } },
    ]);

    const state = fold(twoCalls, [
      { seq: 0, event: { type: "run-start", runId: "run_2" } },
      { seq: 1, event: { type: "tool-progress", toolCallId: "tc_1", data: { stage: "a" } } },
      {
        seq: 2,
        event: {
          type: "tool-result",
          messageId: "m1",
          part: { type: "tool-result", toolCallId: "tc_1", name: "research", status: "ok" },
        },
      },
      { seq: 3, event: { type: "tool-progress", toolCallId: "tc_2", data: { stage: "b" } } },
    ]);

    expect(callOf(state, "tc_2")!.progress).toEqual([{ stage: "b" }]);
  });

  test("once the result lands the call is closed again, so a replay adds nothing", () => {
    // The carve-out is exactly as wide as the case: parked *and* unanswered. A
    // whole conversation replayed onto a client that already holds it must not
    // log the resumed execution twice.
    const done = fold(fold(initialChatState(), PARKED), RESUMED);
    const restored = initialChatState({ messages: done.messages });

    const replayed = fold(fold(restored, PARKED), RESUMED);

    expect(callOf(replayed)!.progress).toEqual([{ stage: "resuming" }]);
    expect(callOf(replayed)!.nested).toHaveLength(1);
    expect(runOf(replayed)!.messages[0]!.content).toEqual([
      { type: "text", text: "The pro tier is $80." },
    ]);
  });
});

/**
 * A run cut short while a sub-agent two levels down is still talking.
 *
 * Nothing here ever ends: no `message-end`, no nested `run-end`, no parent
 * `run-end` — which is what the transcript looks like the instant `stop()` is
 * pressed.
 */
/** The wrap the innermost frames of `LIVE_DEEP` arrive in: `tc_9`'s own sub-run. */
const INNER = { toolCallId: "tc_9", runId: "nr_2", agent: "web" };

const LIVE_DEEP: AgentStreamFrame[] = [
  ...NESTED.slice(0, 4),
  { seq: 4, event: nested({ type: "message-start", messageId: "n1", role: "assistant" }) },
  {
    seq: 5,
    event: nested({
      type: "tool-call",
      messageId: "n1",
      part: { type: "tool-call", toolCallId: "tc_9", name: "browse", input: { url: "x" } },
    }),
  },
  {
    seq: 6,
    event: nested(nested({ type: "message-start", messageId: "d1", role: "assistant" }, INNER)),
  },
  {
    seq: 7,
    event: nested(nested({ type: "text-delta", messageId: "d1", delta: "half a thou" }, INNER)),
  },
];

/** Every message in the tree, at any depth, that no reason was ever put on. */
function unfinished(messages: AgentMessage[], trail = "", found: string[] = []): string[] {
  for (const message of messages) {
    if (message.role === "assistant" && message.finishReason === undefined) {
      found.push(`${trail}${message.id}`);
    }
    for (const part of message.content) {
      if (part.type !== "tool-call" || !part.nested) continue;
      for (const run of part.nested) unfinished(run.messages, `${trail}${run.runId}/`, found);
    }
  }
  return found;
}

/** Every nested run in the tree that no reason was ever put on. */
function unfinishedRuns(messages: AgentMessage[], found: string[] = []): string[] {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== "tool-call" || !part.nested) continue;
      for (const run of part.nested) {
        if (run.finishReason === undefined) found.push(run.runId);
        unfinishedRuns(run.messages, found);
      }
    }
  }
  return found;
}

describe("ending a run ends the sub-runs it was holding", () => {
  test("stopping closes every message in the tree, not just the parent's", () => {
    // A `NestedRun` renders with the component that renders `messages`, so a
    // nested message with no finish reason draws a live cursor inside a block
    // that will never receive another frame. `markAborted` is the case no
    // forwarded nested `run-end` can rescue: `stop()` marks the transcript
    // before the server has said anything at all.
    const live = fold(initialChatState(), LIVE_DEEP);

    expect(unfinished(live.messages)).toEqual(["m1", "nr_1/n1", "nr_1/nr_2/d1"]);

    const stopped = markAborted(live);

    expect(unfinished(stopped.messages)).toEqual([]);
    expect(unfinishedRuns(stopped.messages)).toEqual([]);
    expect(runOf(stopped)!.finishReason).toBe("aborted");
  });

  test("run-end closes them the same way, so a label is there either way", () => {
    const state = fold(fold(initialChatState(), LIVE_DEEP), [
      { seq: 8, event: { type: "run-end", runId: "run_1", finishReason: "error" } },
    ]);

    expect(unfinished(state.messages)).toEqual([]);
    expect(runOf(state)!.finishReason).toBe("error");
  });

  test("a sub-run that finished on its own keeps the reason it finished with", () => {
    // The parent being cut short says nothing about a sub-run that already
    // ended cleanly — relabelling it "aborted" would report a result the user
    // was given as one they never got.
    const stopped = markAborted(fold(initialChatState(), NESTED.slice(0, 12)));

    expect(runOf(stopped)!.finishReason).toBe("stop");
    expect(stopped.messages[0]!.finishReason).toBe("aborted");
  });

  test("stopping the turn that answers a question closes the sub-run under it", () => {
    // The two fixes meeting: the parked message is finished, so `run-end` and
    // `markAborted` used to skip straight past it — and the sub-run the resumed
    // tool started is hanging off a tool call inside it.
    const resuming = fold(fold(initialChatState(), PARKED), RESUMED.slice(0, 4));

    expect(runOf(resuming)!.finishReason).toBeUndefined();

    const stopped = markAborted(resuming);

    expect(unfinished(stopped.messages)).toEqual([]);
    expect(runOf(stopped)!.finishReason).toBe("aborted");
    // The parent's own reason is the one it parked with, not the one the stop
    // brought: that message did finish, last turn, awaiting this answer.
    expect(stopped.messages[0]!.finishReason).toBe("awaiting-input");
  });
});
