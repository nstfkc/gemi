import { describe, expect, test } from "vitest";
import { createEnergyVad, rmsOf } from "./energyVad";

/** Feeds `rms` every 30 ms for `ms`, from `t`; returns the changes and the new time. */
function feed(vad: ReturnType<typeof createEnergyVad>, rms: number, ms: number, t: number) {
  const changes: string[] = [];
  for (let at = t; at < t + ms; at += 30) {
    const change = vad.push(rms, at);
    if (change) changes.push(`${change}@${at - t}`);
  }
  return { changes, t: t + ms };
}

describe("createEnergyVad", () => {
  test("speech starts after minSpeechMs above the bar and ends after silenceMs below it", () => {
    const vad = createEnergyVad({ silenceMs: 350, minSpeechMs: 120 });
    let r = feed(vad, 0.002, 600, 0); // a quiet room
    expect(r.changes).toEqual([]);
    r = feed(vad, 0.1, 900, r.t);
    expect(r.changes).toEqual(["start@120"]);
    expect(vad.speaking).toBe(true);
    r = feed(vad, 0.002, 600, r.t);
    expect(r.changes).toEqual(["end@360"]);
    expect(vad.speaking).toBe(false);
  });

  test("a click shorter than minSpeechMs opens no turn", () => {
    const vad = createEnergyVad();
    let r = feed(vad, 0.002, 300, 0);
    r = feed(vad, 0.2, 60, r.t);
    r = feed(vad, 0.002, 600, r.t);
    expect(r.changes).toEqual([]);
  });

  test("a short pause inside a sentence doesn't end it, and soft syllables keep it open (hysteresis)", () => {
    const vad = createEnergyVad({ silenceMs: 350 });
    let r = feed(vad, 0.002, 300, 0);
    r = feed(vad, 0.1, 300, r.t);
    expect(r.changes).toEqual(["start@120"]);
    const pause = feed(vad, 0.002, 240, r.t);
    const soft = feed(vad, 0.03, 600, pause.t); // below the start bar's 0.045, above 0.7×
    expect([...pause.changes, ...soft.changes]).toEqual([]);
    expect(vad.speaking).toBe(true);
  });

  test("the noise floor adapts: steady fan noise is not speech, a voice above it is", () => {
    const vad = createEnergyVad({ minSpeechMs: 90 });
    // a fan at 0.02 — above the fixed minimum, so it would read as speech
    // without the floor; the floor learns it while nobody speaks
    let r = feed(vad, 0.01, 3000, 0);
    r = feed(vad, 0.02, 6000, r.t);
    const fan = feed(vad, 0.02, 3000, r.t);
    expect(fan.changes).toEqual([]);
    const voice = feed(vad, 0.15, 300, fan.t);
    expect(voice.changes).toEqual(["start@90"]);
  });

  test("rmsOf", () => {
    expect(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsOf(new Float32Array())).toBe(0);
  });
});
