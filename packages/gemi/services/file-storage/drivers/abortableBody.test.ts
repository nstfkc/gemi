import { describe, expect, test } from "vitest";

import { abortableBody } from "./abortableBody";

/** A source that yields `chunks` and then stalls, like a hung connection. */
function stallingSource(chunks: string[] = ["a"]) {
  const state = { cancelled: false, reason: undefined as unknown };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[i++]));
      }
      // Past the last chunk: never enqueue, never close.
      return new Promise(() => {});
    },
    cancel(reason) {
      state.cancelled = true;
      state.reason = reason;
    },
  });
  return { stream, state };
}

/** Counts the abort listeners attached to a signal. */
function countingSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    if (args[0] === "abort") listeners += 1;
    return add(...args);
  }) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    if (args[0] === "abort") listeners -= 1;
    return remove(...args);
  }) as typeof remove;
  return { controller, signal, listeners: () => listeners };
}

describe("abortableBody()", () => {
  test("returns the body untouched without a signal", () => {
    const { stream } = stallingSource();
    expect(abortableBody(stream, undefined)).toBe(stream);
  });

  test("passes the bytes through when nothing aborts", async () => {
    const source = new Blob(["hello ", "world"]).stream();
    const controller = new AbortController();

    const text = await new Response(abortableBody(source, controller.signal)).text();

    expect(text).toBe("hello world");
  });

  test("errors a pending read and cancels the source when the signal aborts", async () => {
    const { stream, state } = stallingSource(["first"]);
    const controller = new AbortController();
    const reader = abortableBody(stream, controller.signal).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");

    const pending = reader.read();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.cancelled).toBe(true);
    expect((state.reason as Error).name).toBe("AbortError");
  });

  test("makes arrayBuffer() reject instead of hanging", async () => {
    const { stream, state } = stallingSource(["x", "y"]);
    const controller = new AbortController();

    const buffered = new Response(abortableBody(stream, controller.signal)).arrayBuffer();
    setTimeout(() => controller.abort(), 5);

    await expect(buffered).rejects.toMatchObject({ name: "AbortError" });
    expect(state.cancelled).toBe(true);
  });

  test("carries a timeout's reason", async () => {
    const { stream } = stallingSource([]);
    const reader = abortableBody(stream, AbortSignal.timeout(5)).getReader();

    await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("errors at once for a signal that is already aborted", async () => {
    const { stream, state } = stallingSource();
    const controller = new AbortController();
    controller.abort();

    const reader = abortableBody(stream, controller.signal).getReader();

    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(state.cancelled).toBe(true);
  });

  test("detaches from the signal once the body is fully read", async () => {
    const { signal, listeners } = countingSignal();

    await new Response(abortableBody(new Blob(["abc"]).stream(), signal)).text();

    expect(listeners()).toBe(0);
  });

  test("detaches from the signal when the consumer cancels", async () => {
    const { stream, state } = stallingSource();
    const { signal, listeners } = countingSignal();

    await abortableBody(stream, signal).cancel("done");

    expect(listeners()).toBe(0);
    expect(state.cancelled).toBe(true);
    expect(state.reason).toBe("done");
  });
});
