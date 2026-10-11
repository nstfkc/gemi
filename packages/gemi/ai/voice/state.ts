import type { VoiceCaption, VoiceStatus } from "./wire";

/**
 * What `useVoiceSession` shows, as a pure reducer over the call's data-channel
 * events (#921). Separate from the hook so it is tested without a DOM, a
 * microphone or a peer connection.
 *
 * The events are the vendor's, as the data channel delivers them. Which ones
 * arrive there — in particular the `function_call_output` items the server's
 * sideband adds, which end `working` — follows the documented protocol and has
 * not been measured against Azure.
 */
export type VoiceState = {
  phase: "idle" | "connecting" | "live" | "ended";
  /** The user is speaking (VAD) or holding push-to-talk. */
  userSpeaking: boolean;
  /** The user stopped and no answer has started playing. */
  thinking: boolean;
  /** The voice's audio is playing. */
  speaking: boolean;
  /** Delegate calls with no output yet. */
  working: string[];
  captions: VoiceCaption[];
};

export const MAX_CAPTIONS = 20;

export function initialVoiceState(): VoiceState {
  return {
    phase: "idle",
    userSpeaking: false,
    thinking: false,
    speaking: false,
    working: [],
    captions: [],
  };
}

export function voiceStatus(state: VoiceState): VoiceStatus {
  if (state.phase === "idle") return "idle";
  if (state.phase === "connecting") return "connecting";
  if (state.phase === "ended") return "ended";
  if (state.speaking) return "speaking";
  if (state.userSpeaking) return "listening";
  if (state.thinking) return "thinking";
  if (state.working.length) return "working";
  return "listening";
}

type Event = { type: string; [key: string]: any };

/** One data-channel event onto the state. `delegate` is the delegate tool's name. */
export function applyVoiceEvent(state: VoiceState, event: Event, delegate: string): VoiceState {
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      return { ...state, userSpeaking: true, thinking: false };
    case "input_audio_buffer.speech_stopped":
    case "input_audio_buffer.committed":
      return { ...state, userSpeaking: false, thinking: true };
    case "output_audio_buffer.started":
      return { ...state, speaking: true, thinking: false };
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      return { ...state, speaking: false };
    case "response.done": {
      let next = { ...state, thinking: false };
      for (const item of event.response?.output ?? []) {
        if (item?.type === "function_call" && item.name === delegate && item.call_id) {
          next = addWorking(next, item.call_id);
        }
      }
      return next;
    }
    case "response.function_call_arguments.done":
      return event.name === delegate && event.call_id ? addWorking(state, event.call_id) : state;
    case "conversation.item.added":
    case "conversation.item.created":
    case "conversation.item.done": {
      const item = event.item;
      if (item?.type === "function_call_output" && state.working.includes(item.call_id)) {
        return { ...state, working: state.working.filter((id) => id !== item.call_id) };
      }
      return state;
    }
    case "conversation.item.input_audio_transcription.delta":
      return caption(state, event.item_id, "user", event.delta ?? "", false);
    case "conversation.item.input_audio_transcription.completed":
      return caption(state, event.item_id, "user", event.transcript ?? "", true);
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      return caption(state, event.item_id, "assistant", event.delta ?? "", false);
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      return caption(state, event.item_id, "assistant", event.transcript ?? "", true);
    default:
      return state;
  }
}

function addWorking(state: VoiceState, callId: string): VoiceState {
  return state.working.includes(callId) ? state : { ...state, working: [...state.working, callId] };
}

/** A delta appends to its line; a final text replaces it. */
function caption(
  state: VoiceState,
  id: string | undefined,
  role: VoiceCaption["role"],
  text: string,
  final: boolean,
): VoiceState {
  if (!id) return state;
  const index = state.captions.findIndex((line) => line.id === id);
  const captions = [...state.captions];
  if (index === -1) {
    if (!text) return state;
    captions.push({ id, role, text, final });
  } else {
    const line = captions[index]!;
    captions[index] = { ...line, text: final ? text || line.text : line.text + text, final };
  }
  return { ...state, captions: captions.slice(-MAX_CAPTIONS) };
}
