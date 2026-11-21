import { describe, expect, test } from "vitest";

import type { AgentStreamFrame } from "../types";
import {
  applyRunFrame,
  initialChatState,
  liveRunIds,
  markAllAborted,
  runCursor,
  type ChatState,
} from "./reducer";

/**
 * Several runs streaming into one transcript at once: parallel turns on a
 * thread, or one reply arriving on two connections. Each run is applied
 * against its own cursor.
 */

const NOW = "2026-11-21T00:00:00.000Z";

const run = (runId: string, messageId: string, text: string): AgentStreamFrame[] => [
  { seq: 1, event: { type: "run-start", runId, threadId: "th_1" } },
  { seq: 2, event: { type: "message-start", messageId, role: "assistant" } },
  { seq: 3, event: { type: "text-delta", messageId, delta: text } },
  { seq: 4, event: { type: "message-end", messageId, finishReason: "stop" } },
  { seq: 5, event: { type: "run-end", runId, finishReason: "stop" } },
];

const apply = (state: ChatState, runId: string, frames: AgentStreamFrame[]) =>
  frames.reduce((current, frame) => applyRunFrame(current, runId, frame, NOW), state);

const textOf = (state: ChatState, id: string) =>
  state.messages
    .find((message) => message.id === id)!
    .content.map((part) => (part.type === "text" ? part.text : ""))
    .join("");

describe("applyRunFrame", () => {
  test("two runs interleaved: each message is built from its own frames and finishes on its own", () => {
    const a = run("run_a", "ma", "first");
    const b = run("run_b", "mb", "second");
    let state = initialChatState({ threadId: "th_1" });
    // a starts and is the primary; b starts while a goes, with the same seqs.
    state = apply(state, "run_a", a.slice(0, 3));
    state = apply(state, "run_b", b.slice(0, 3));
    expect(state.runId).toBe("run_a");
    expect(liveRunIds(state)).toEqual(["run_a", "run_b"]);
    expect(textOf(state, "ma")).toBe("first");
    expect(textOf(state, "mb")).toBe("second");

    // b ends first: a is still the primary, and only b's message is finished.
    state = apply(state, "run_b", b.slice(3));
    expect(state.runId).toBe("run_a");
    expect(state.messages.find((m) => m.id === "mb")!.finishReason).toBe("stop");
    expect(state.messages.find((m) => m.id === "ma")!.finishReason).toBeUndefined();
    expect(liveRunIds(state)).toEqual(["run_a"]);

    state = apply(state, "run_a", a.slice(3));
    expect(state.runId).toBeUndefined();
    expect(state.messages.map((m) => m.finishReason)).toEqual(["stop", "stop"]);
  });

  test("a frame delivered twice, on two streams of the same run, is applied once", () => {
    const a = run("run_a", "ma", "once");
    let state = apply(initialChatState(), "run_a", a.slice(0, 3));
    const again = apply(state, "run_a", a.slice(0, 3));
    expect(again).toBe(state);
    state = apply(state, "run_b", run("run_b", "mb", "x").slice(0, 3));
    // A lane redelivered is a no-op too.
    expect(apply(state, "run_b", run("run_b", "mb", "x").slice(0, 3))).toBe(state);
    expect(textOf(state, "ma")).toBe("once");
  });

  test("when the primary run ends, a run still going becomes the primary", () => {
    let state = apply(initialChatState(), "run_a", run("run_a", "ma", "a").slice(0, 3));
    state = apply(state, "run_b", run("run_b", "mb", "b").slice(0, 3));
    state = apply(state, "run_a", run("run_a", "ma", "a").slice(3));
    expect(state.runId).toBe("run_b");
    expect(state.cursorRunId).toBe("run_b");
    expect(state.seq).toBe(3);
    // The ended run keeps its cursor, so a late copy of its frames is still a duplicate.
    expect(runCursor(state, "run_a")).toBe(5);
    const late = apply(state, "run_a", run("run_a", "ma", "a"));
    expect(late).toBe(state);
  });

  test("a run that starts after the primary ended takes its place, as a single stream always did", () => {
    let state = apply(initialChatState(), "run_a", run("run_a", "ma", "a"));
    state = apply(state, "run_b", run("run_b", "mb", "b").slice(0, 2));
    expect(state.runId).toBe("run_b");
    expect(state.cursorRunId).toBe("run_b");
    expect(runCursor(state, "run_a")).toBe(5);
  });

  test("markAllAborted cuts every run followed, and only their messages", () => {
    let state = apply(initialChatState(), "run_a", run("run_a", "ma", "a").slice(0, 3));
    state = apply(state, "run_b", run("run_b", "mb", "b").slice(0, 3));
    const stopped = markAllAborted(state);
    expect(stopped.messages.map((m) => m.finishReason)).toEqual(["aborted", "aborted"]);
    expect(liveRunIds(stopped)).toEqual([]);
  });

  test("a joined message shows where the run took it, renamed from the client's copy", () => {
    let state = initialChatState({
      messages: [
        {
          id: "local_1",
          localId: "local_1",
          role: "user",
          content: [{ type: "text", text: "also blue" }],
          createdAt: NOW,
        },
      ],
    });
    state = applyRunFrame(
      state,
      "run_a",
      {
        seq: 7,
        event: {
          type: "message-id",
          localId: "local_1",
          messageId: "msg_9",
          message: {
            id: "msg_9",
            role: "user",
            content: [{ type: "text", text: "also blue" }],
            createdAt: NOW,
            joined: true,
          },
        },
      },
      NOW,
    );
    expect(state.messages.map((m) => m.id)).toEqual(["msg_9"]);
    expect(state.messages[0]!.localId).toBe("local_1");
  });
});
