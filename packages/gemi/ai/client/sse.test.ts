import { describe, expect, test } from "vitest";
import { decodeSSE, SSEFrameDecoder } from "./sse";

/**
 * A realistic wire fixture, including the three things a hand-rolled parser
 * usually gets wrong: a keepalive comment, a `data:` payload spread over two
 * lines, and a non-ASCII character whose UTF-8 bytes can be split by a chunk
 * boundary.
 */
const WIRE =
  ": keepalive\n\n" +
  'id: 0\ndata: {"type":"run-start","runId":"run_1","threadId":"th_1"}\n\n' +
  'id: 1\ndata: {"type":"message-start","messageId":"m1","role":"assistant"}\n\n' +
  'id: 2\ndata: {"type":"text-delta",\ndata: "messageId":"m1","delta":"héllo ✅"}\n\n' +
  ": keepalive\n\n" +
  'id: 3\ndata: {"type":"message-end","messageId":"m1","finishReason":"stop"}\n\n' +
  'id: 4\ndata: {"type":"run-end","runId":"run_1","finishReason":"stop"}\n\n';

function collect(decoder: SSEFrameDecoder, chunks: (string | Uint8Array)[]) {
  const frames = chunks.flatMap((chunk) => decoder.push(chunk));
  return [...frames, ...decoder.flush()];
}

describe("SSEFrameDecoder", () => {
  test("decodes a run, taking seq from the id field", () => {
    const frames = collect(new SSEFrameDecoder(), [WIRE]);

    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(frames.map((f) => f.event.type)).toEqual([
      "run-start",
      "message-start",
      "text-delta",
      "message-end",
      "run-end",
    ]);
  });

  test("multi-line data rejoins with a newline, so the JSON still parses", () => {
    const [, , delta] = collect(new SSEFrameDecoder(), [WIRE]);

    expect(delta!.event).toEqual({ type: "text-delta", messageId: "m1", delta: "héllo ✅" });
  });

  test("keepalive comments produce no frames", () => {
    const frames = collect(new SSEFrameDecoder(), [": keepalive\n\n:\n\n: another\n\n"]);

    expect(frames).toEqual([]);
  });

  test("every byte-level split of the same stream decodes identically", () => {
    // The real failure mode: `reader.read()` boundaries have nothing to do with
    // event boundaries, and a multi-byte character split across two chunks is
    // what turns "usually works" into a mangled delta once in a thousand runs.
    const bytes = new TextEncoder().encode(WIRE);
    const whole = collect(new SSEFrameDecoder(), [bytes]);

    for (let cut = 0; cut <= bytes.length; cut++) {
      const split = collect(new SSEFrameDecoder(), [bytes.slice(0, cut), bytes.slice(cut)]);
      expect(split, `split at byte ${cut}`).toEqual(whole);
    }
  });

  test("a chunk boundary inside a data line does not lose the line", () => {
    const cut = WIRE.indexOf('"delta"');
    const frames = collect(new SSEFrameDecoder(), [WIRE.slice(0, cut), WIRE.slice(cut)]);

    expect(frames).toHaveLength(5);
  });

  test("a truncated tail is discarded rather than half-applied", () => {
    const decoder = new SSEFrameDecoder();
    const frames = collect(decoder, [
      'id: 0\ndata: {"type":"run-start","runId":"run_1"}\n\n',
      'id: 1\ndata: {"type":"text-de',
    ]);

    // Four bytes of a text-delta is not a text-delta. An event with no
    // terminating blank line never dispatched, and flush must not invent one.
    expect(frames.map((f) => f.event.type)).toEqual(["run-start"]);
  });

  test("an unparseable frame is skipped without taking the stream with it", () => {
    const frames = collect(new SSEFrameDecoder(), [
      'id: 0\ndata: {"type":"run-start","runId":"run_1"}\n\n',
      "id: 1\ndata: {not json}\n\n",
      'id: 2\ndata: {"type":"run-end","runId":"run_1","finishReason":"stop"}\n\n',
    ]);

    expect(frames.map((f) => f.seq)).toEqual([0, 2]);
  });

  test("CRLF line endings, including a CR left at a chunk boundary", () => {
    const crlf = WIRE.replace(/\n/g, "\r\n");
    const cut = crlf.indexOf("\r\n") + 1; // between the CR and the LF
    const frames = collect(new SSEFrameDecoder(), [crlf.slice(0, cut), crlf.slice(cut)]);

    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a frame with no id continues the count rather than restarting it", () => {
    // Seq is the replay guard downstream, so an id-less frame that resolved to
    // 0 would read as already-applied for the rest of the run.
    const frames = collect(new SSEFrameDecoder(), [
      'id: 7\ndata: {"type":"tool-search","loaded":["a"]}\n\n',
      'data: {"type":"tool-search","loaded":["b"]}\n\n',
      'data: {"type":"tool-search","loaded":["c"]}\n\n',
    ]);

    expect(frames.map((f) => f.seq)).toEqual([7, 8, 9]);
  });

  test("cursor tracks the highest id seen", () => {
    const decoder = new SSEFrameDecoder();
    expect(decoder.cursor).toBe(-1);
    decoder.push(WIRE);
    expect(decoder.cursor).toBe(4);
  });
});

describe("decodeSSE", () => {
  test("reads a ReadableStream to the end", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(WIRE.slice(0, 40)));
        controller.enqueue(encoder.encode(WIRE.slice(40)));
        controller.close();
      },
    });

    const frames = [];
    for await (const frame of decodeSSE(stream)) frames.push(frame);

    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a missing body is an empty stream, not a crash", async () => {
    const frames = [];
    for await (const frame of decodeSSE(null)) frames.push(frame);

    expect(frames).toEqual([]);
  });

  test("breaking out of the loop cancels the stream", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(WIRE));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _frame of decodeSSE(stream)) break;

    expect(cancelled).toBe(true);
  });
});
