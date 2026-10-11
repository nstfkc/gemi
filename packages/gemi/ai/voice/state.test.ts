import { describe, expect, test } from "vitest";

import {
  applyVoiceEvent,
  initialVoiceState,
  MAX_CAPTIONS,
  voiceStatus,
  type VoiceState,
} from "./state";

const live = (): VoiceState => ({ ...initialVoiceState(), phase: "live" });
const apply = (state: VoiceState, ...events: any[]) =>
  events.reduce((s, e) => applyVoiceEvent(s, e, "ask_agent"), state);

describe("voice state", () => {
  test("status follows the call: listening, thinking, speaking, listening", () => {
    let s = live();
    expect(voiceStatus(s)).toBe("listening");
    s = apply(s, { type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(voiceStatus(s)).toBe("listening");
    s = apply(s, { type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    expect(voiceStatus(s)).toBe("thinking");
    s = apply(s, { type: "output_audio_buffer.started" });
    expect(voiceStatus(s)).toBe("speaking");
    s = apply(s, { type: "output_audio_buffer.stopped" });
    expect(voiceStatus(s)).toBe("listening");
  });

  test("working from the delegate call until its output arrives; other tools do not count", () => {
    let s = apply(live(), {
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "ask_agent",
      arguments: "{}",
    });
    s = apply(s, {
      type: "response.function_call_arguments.done",
      call_id: "c2",
      name: "work_status",
    });
    expect(s.working).toEqual(["c1"]);
    expect(voiceStatus(s)).toBe("working");
    s = apply(s, { type: "output_audio_buffer.started" });
    expect(voiceStatus(s)).toBe("speaking");
    s = apply(
      s,
      { type: "output_audio_buffer.stopped" },
      { type: "conversation.item.added", item: { type: "function_call_output", call_id: "c1" } },
    );
    expect(voiceStatus(s)).toBe("listening");
  });

  test("a delegate call seen only on response.done still counts", () => {
    const s = apply(live(), {
      type: "response.done",
      response: { output: [{ type: "function_call", name: "ask_agent", call_id: "c9" }] },
    });
    expect(s.working).toEqual(["c9"]);
  });

  test("captions: deltas append per item, the final text replaces, and old lines drop off", () => {
    let s = apply(
      live(),
      {
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "u1",
        delta: "Make it ",
      },
      { type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "dark" },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "On it" },
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Make it darker.",
      },
      // the beta name
      { type: "response.audio_transcript.done", item_id: "a1", transcript: "On it." },
    );
    expect(s.captions).toEqual([
      { id: "u1", role: "user", text: "Make it darker.", final: true },
      { id: "a1", role: "assistant", text: "On it.", final: true },
    ]);
    for (let i = 0; i < MAX_CAPTIONS + 5; i++) {
      s = apply(s, {
        type: "response.output_audio_transcript.done",
        item_id: `x${i}`,
        transcript: `line ${i}`,
      });
    }
    expect(s.captions).toHaveLength(MAX_CAPTIONS);
    expect(s.captions.at(-1)!.text).toBe(`line ${MAX_CAPTIONS + 4}`);
  });

  test("idle, connecting and ended win over everything", () => {
    expect(voiceStatus(initialVoiceState())).toBe("idle");
    expect(voiceStatus({ ...live(), phase: "connecting", speaking: true })).toBe("connecting");
    expect(voiceStatus({ ...live(), phase: "ended", speaking: true })).toBe("ended");
  });
});
