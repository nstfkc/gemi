/**
 * The built-in end-of-speech detector for `useLiveTranscription` (#929): a
 * small energy (RMS) detector with an adaptive noise floor and hysteresis.
 *
 * WHY ENERGY AND NOT A MODEL. `gpt-live-transcribe` has no server-side turn
 * detection, so the browser decides when the user stopped and commits the
 * turn. A neural VAD (Silero through `@ricky0123/vad-web`) is better in
 * noise, but it ships an ONNX runtime and a model, megabytes against the few
 * hundred bytes here, and needs its wasm/model files served from the app's
 * origin. What this detector has to do is narrow: the user is close to the
 * mic, the browser's own noise suppression and echo cancellation are on, and
 * the question is only "did the speech stop for `silenceMs`". An adaptive
 * floor handles a fan or a room; a false end in a long pause costs one early
 * commit, after which the rest of the sentence is the next turn. Apps that
 * need more plug a model in through `vad` (see `VoiceActivityDetector`).
 *
 * Pure: frames in (RMS and a timestamp), `"start"` / `"end"` out, so it is
 * tested without audio.
 */

export type EnergyVadOptions = {
  /** Silence after speech before the turn ends. Default 350 ms. */
  silenceMs?: number;
  /** Speech must last this long to count, so a click or a cough doesn't open a
   *  turn. Default 120 ms. */
  minSpeechMs?: number;
  /** The lowest RMS (0–1 float samples) that can count as speech, whatever
   *  the noise floor. Default 0.015. */
  threshold?: number;
  /** Speech is RMS above the noise floor times this. Default 3. */
  floorRatio?: number;
};

export const DEFAULT_SILENCE_MS = 350;

export type EnergyVad = {
  /** One analysis frame: its RMS and when it was taken (ms). */
  push(rms: number, at: number): "start" | "end" | null;
  readonly speaking: boolean;
  reset(): void;
};

export function createEnergyVad(options: EnergyVadOptions = {}): EnergyVad {
  const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
  const minSpeechMs = options.minSpeechMs ?? 120;
  const minThreshold = options.threshold ?? 0.015;
  const floorRatio = options.floorRatio ?? 3;

  let floor = minThreshold / floorRatio;
  let speaking = false;
  /** When the current run of loud frames began, before it counts as speech. */
  let loudSince: number | null = null;
  /** When the current run of quiet frames began, while speaking. */
  let quietSince: number | null = null;

  return {
    get speaking() {
      return speaking;
    },
    reset() {
      speaking = false;
      loudSince = null;
      quietSince = null;
    },
    push(rms, at) {
      const threshold = Math.max(minThreshold, floor * floorRatio);
      if (!speaking) {
        if (rms > threshold) {
          loudSince ??= at;
          if (at - loudSince >= minSpeechMs) {
            speaking = true;
            quietSince = null;
            return "start";
          }
        } else {
          loudSince = null;
          // The floor follows the room only while nobody speaks: fast down,
          // slow up, so a rising voice is not learned as noise.
          floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005;
        }
        return null;
      }
      // Hysteresis: speech ends below a lower bar than it starts above, so a
      // soft syllable doesn't end the turn.
      if (rms > threshold * 0.7) {
        quietSince = null;
        return null;
      }
      quietSince ??= at;
      if (at - quietSince >= silenceMs) {
        speaking = false;
        loudSince = null;
        quietSince = null;
        return "end";
      }
      return null;
    },
  };
}

/** RMS of float time-domain samples. */
export function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
