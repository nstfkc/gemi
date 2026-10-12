/**
 * What `useLiveTranscription` shows, as a pure reducer over a transcription
 * session's data-channel events (#929). Tested without a DOM or a peer
 * connection, like `state.ts` for `useVoiceSession`.
 *
 * The events are OpenAI's (realtime transcription guide):
 * `conversation.item.input_audio_transcription.delta` (`item_id`, `delta`)
 * while the user speaks, and `.completed` (`item_id`, `transcript`, `usage`)
 * once the turn is committed. Completions of different turns may arrive out of
 * order, so turns are keyed and ordered by `item_id`, by when each item was
 * first seen.
 */

/** One finished turn: what the user said between two commits. */
export type TranscriptTurn = {
  /** The vendor's item id. */
  id: string;
  text: string;
  /** Audio seconds the vendor billed for it, when it said (duration-billed
   *  models such as `gpt-live-transcribe`). */
  seconds?: number;
};

export type TranscriptionState = {
  /** Item ids in the order they were first seen. */
  order: string[];
  /** Text so far of items not yet completed. */
  partials: Record<string, string>;
  /** Completed turns, oldest first, at most `MAX_TURNS`. */
  turns: TranscriptTurn[];
  /** Commits sent whose transcript hasn't arrived. */
  pendingCommits: number;
};

export const MAX_TURNS = 50;

export function initialTranscriptionState(): TranscriptionState {
  return { order: [], partials: {}, turns: [], pendingCommits: 0 };
}

/** The live text: every unfinished item's text, in order. */
export function partialText(state: TranscriptionState): string {
  return state.order
    .map((id) => state.partials[id])
    .filter((text): text is string => !!text)
    .join(" ")
    .trim();
}

export type TranscriptionEvent = { type: string; [key: string]: unknown };

export type TranscriptionEffect =
  | { type: "final"; turn: TranscriptTurn }
  | { type: "error"; code?: string; message: string };

/** Vendor error codes that are part of normal operation, not failures: a
 *  commit with nothing in the buffer (a manual `commit()` in silence). */
const BENIGN_ERRORS = new Set(["input_audio_buffer_commit_empty"]);

export function applyTranscriptionEvent(
  state: TranscriptionState,
  event: TranscriptionEvent,
): { state: TranscriptionState; effects: TranscriptionEffect[] } {
  const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
  const seen = (id: string) => (state.order.includes(id) ? state.order : [...state.order, id]);

  switch (event.type) {
    case "conversation.item.input_audio_transcription.delta": {
      if (!itemId || typeof event.delta !== "string") break;
      if (state.turns.some((turn) => turn.id === itemId)) break;
      return {
        state: {
          ...state,
          order: seen(itemId),
          partials: { ...state.partials, [itemId]: (state.partials[itemId] ?? "") + event.delta },
        },
        effects: [],
      };
    }
    case "input_audio_buffer.committed": {
      if (!itemId) break;
      return { state: { ...state, order: seen(itemId) }, effects: [] };
    }
    case "conversation.item.input_audio_transcription.completed": {
      if (!itemId || state.turns.some((turn) => turn.id === itemId)) break;
      const usage = event.usage as { type?: string; seconds?: unknown } | undefined;
      const seconds = usage?.type === "duration" ? Number(usage.seconds) : NaN;
      const turn: TranscriptTurn = {
        id: itemId,
        text: typeof event.transcript === "string" ? event.transcript.trim() : "",
        ...(Number.isFinite(seconds) ? { seconds } : {}),
      };
      const order = seen(itemId);
      const { [itemId]: _done, ...partials } = state.partials;
      const all = [...state.turns, turn].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const turns = all.slice(-MAX_TURNS);
      // Turns that fell off the end leave `order` too, so a long session
      // doesn't grow it without bound. Items still pending stay.
      const dropped = new Set(all.slice(0, -MAX_TURNS).map((t) => t.id));
      return {
        state: {
          ...state,
          order: dropped.size ? order.filter((id) => !dropped.has(id)) : order,
          partials,
          turns,
          pendingCommits: Math.max(0, state.pendingCommits - 1),
        },
        effects: [{ type: "final", turn }],
      };
    }
    case "conversation.item.input_audio_transcription.failed": {
      const { [itemId ?? ""]: _dropped, ...partials } = state.partials;
      const error = (event.error ?? {}) as { code?: string; message?: string };
      return {
        state: { ...state, partials, pendingCommits: Math.max(0, state.pendingCommits - 1) },
        effects: [
          { type: "error", code: error.code, message: error.message ?? "Transcription failed." },
        ],
      };
    }
    case "error": {
      const error = (event.error ?? {}) as { code?: string; message?: string };
      if (error.code && BENIGN_ERRORS.has(error.code)) {
        return {
          state: { ...state, pendingCommits: Math.max(0, state.pendingCommits - 1) },
          effects: [],
        };
      }
      return {
        state,
        effects: [{ type: "error", code: error.code, message: error.message ?? "Vendor error." }],
      };
    }
  }
  return { state, effects: [] };
}
