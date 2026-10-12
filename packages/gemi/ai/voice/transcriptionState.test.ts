import { describe, expect, test } from "vitest";
import {
  applyTranscriptionEvent,
  initialTranscriptionState,
  MAX_TURNS,
  partialText,
  type TranscriptionEvent,
  type TranscriptionState,
} from "./transcriptionState";

function run(events: TranscriptionEvent[], from = initialTranscriptionState()) {
  let state: TranscriptionState = from;
  const effects: unknown[] = [];
  for (const event of events) {
    const out = applyTranscriptionEvent(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const delta = (item_id: string, d: string) => ({
  type: "conversation.item.input_audio_transcription.delta",
  item_id,
  content_index: 0,
  delta: d,
});
const completed = (item_id: string, transcript: string, seconds?: number) => ({
  type: "conversation.item.input_audio_transcription.completed",
  item_id,
  content_index: 0,
  transcript,
  ...(seconds === undefined ? {} : { usage: { type: "duration", seconds } }),
});

describe("applyTranscriptionEvent", () => {
  test("deltas build the partial; completed replaces it with the final and its billed seconds", () => {
    const pending = { ...initialTranscriptionState(), pendingCommits: 1 };
    let r = run([delta("item_1", "Switch "), delta("item_1", "to mob")], pending);
    expect(partialText(r.state)).toBe("Switch to mob");
    r = run([completed("item_1", " Switch to mobile. ", 1.2)], r.state);
    expect(partialText(r.state)).toBe("");
    expect(r.state.turns).toEqual([{ id: "item_1", text: "Switch to mobile.", seconds: 1.2 }]);
    expect(r.effects).toEqual([
      { type: "final", turn: { id: "item_1", text: "Switch to mobile.", seconds: 1.2 } },
    ]);
    expect(r.state.pendingCommits).toBe(0);
  });

  test("completions out of order are placed by when each item was first seen", () => {
    const r = run([
      delta("a", "first"),
      { type: "input_audio_buffer.committed", item_id: "a" },
      delta("b", "second"),
      completed("b", "second"),
      completed("a", "first"),
    ]);
    expect(r.state.turns.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("a late delta for a finished item, or a repeated completion, changes nothing", () => {
    let r = run([completed("a", "done")]);
    const before = r.state;
    r = run([delta("a", " more"), completed("a", "again")], before);
    expect(r.state).toBe(before);
    expect(r.effects).toEqual([]);
  });

  test("an empty commit is benign; other errors and failed items are reported", () => {
    const pending = { ...initialTranscriptionState(), pendingCommits: 2 };
    const r = run(
      [
        { type: "error", error: { code: "input_audio_buffer_commit_empty", message: "empty" } },
        delta("x", "hal"),
        {
          type: "conversation.item.input_audio_transcription.failed",
          item_id: "x",
          error: { code: "audio_unintelligible", message: "Could not transcribe." },
        },
        { type: "error", error: { code: "invalid_value", message: "Bad keyword." } },
      ],
      pending,
    );
    expect(r.state.pendingCommits).toBe(0);
    expect(partialText(r.state)).toBe("");
    expect(r.effects).toEqual([
      { type: "error", code: "audio_unintelligible", message: "Could not transcribe." },
      { type: "error", code: "invalid_value", message: "Bad keyword." },
    ]);
  });

  test("keeps the last MAX_TURNS turns and forgets the order of the dropped ones", () => {
    const events = Array.from({ length: MAX_TURNS + 5 }, (_, i) => completed(`i${i}`, `t${i}`));
    const r = run([delta("live", "still talking"), ...events]);
    expect(r.state.turns).toHaveLength(MAX_TURNS);
    expect(r.state.turns[0]!.id).toBe("i5");
    expect(r.state.order).toHaveLength(MAX_TURNS + 1);
    expect(partialText(r.state)).toBe("still talking");
  });
});
