import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentStreamFrame } from "../types";
import { SSE_KEEPALIVE, SSE_KEEPALIVE_INTERVAL_MS, sseResponse } from "./sse";

const bytes = new TextDecoder();

const frame = (seq: number): AgentStreamFrame => ({
  seq,
  event: { type: "text-delta", messageId: "m1", delta: String(seq) },
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A run that writes one frame, goes quiet until released, writes one more,
 *  and goes quiet again until it is told to end. */
function slowRun() {
  const release = deferred();
  const end = deferred();
  async function* frames() {
    yield frame(1);
    await release.promise;
    yield frame(2);
    await end.promise;
  }
  return { frames: frames(), release, end };
}

describe("sseResponse keepalive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a comment line goes out for every interval of silence, and a frame resets the clock", async () => {
    vi.useFakeTimers();
    const { frames, release, end } = slowRun();
    const reader = sseResponse(frames).body!.getReader();
    const read = async () => bytes.decode((await reader.read()).value);

    expect(await read()).toContain("id: 1\n");

    // The consumer is waiting and the run has nothing to say.
    let pending = reader.read();
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
    expect(bytes.decode((await pending).value)).toBe(SSE_KEEPALIVE);

    // Silence that goes on gets another one, on the same clock.
    pending = reader.read();
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
    expect(bytes.decode((await pending).value)).toBe(SSE_KEEPALIVE);

    // A frame arriving just before the next tick pushes the tick back.
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS - 1);
    release.resolve();
    expect(await read()).toContain("id: 2\n");
    let settled = false;
    pending = reader.read().then((chunk) => {
      settled = true;
      return chunk;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS - 1);
    expect(bytes.decode((await pending).value)).toBe(SSE_KEEPALIVE);

    end.resolve();
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a consumer that cancels leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { frames } = slowRun();
    const body = sseResponse(frames).body!;
    expect(vi.getTimerCount()).toBe(1);
    await body.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
