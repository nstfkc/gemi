import { describe, expect, test } from "vitest";
import type { AgentMessage, AgentStreamFrame } from "../types";
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
    expect(at(1).messages).toEqual([
      { id: "m1", role: "assistant", content: [], createdAt: NOW },
    ]);
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

    expect(content.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-result",
      "text",
    ]);
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

  test("tool-search and tool-progress advance the cursor and nothing else", () => {
    const before = at(6);
    const after = fold(before, [
      { seq: 7, event: { type: "tool-search", loaded: ["refundOrder"] } },
      { seq: 8, event: { type: "tool-progress", toolCallId: "tc_1", data: { line: "$ ls" } } },
    ]);

    expect(after.messages).toEqual(before.messages);
    expect(after.seq).toBe(8);
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
