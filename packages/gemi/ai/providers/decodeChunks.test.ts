import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { decodeChunks } from "./stream";

/**
 * `decodeChunks` holds the provider body's reader. Whatever stops it (the end
 * of the stream, a consumer that breaks off, a failed read), it must give the
 * body back without leaving a rejection nobody handles (#1407).
 */

const encoder = new TextEncoder();

function source(chunks: string[], onCancel?: (reason: unknown) => void) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
    cancel: onCancel,
  });
}

/** A body whose reader behaves like Bun's: `releaseLock()` rejects `closed`
 *  with "Reader released", and nothing marks that rejection handled. */
function bunLikeBody(chunks: Uint8Array[], options: { releaseThrows?: boolean } = {}) {
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((_resolve, reject) => (rejectClosed = reject));
  let i = 0;
  const calls = { cancel: 0, release: 0 };
  const reader = {
    closed,
    read: async () =>
      i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
    cancel: async () => {
      calls.cancel++;
    },
    releaseLock: () => {
      calls.release++;
      rejectClosed(new TypeError("Invalid state: Reader released"));
      if (options.releaseThrows) throw new TypeError("Invalid state: Reader released");
    },
  };
  const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
  return { body, calls };
}

async function collect(chunks: AsyncIterable<string>) {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

/** Long enough for the runtime to report a rejection nobody handled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("decodeChunks", () => {
  test("decodes a character split across two reads and gives the body back", async () => {
    const bytes = encoder.encode("é");
    let i = 0;
    const parts = [bytes.slice(0, 1), bytes.slice(1)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < parts.length) controller.enqueue(parts[i++]!);
        else controller.close();
      },
    });

    expect(await collect(decodeChunks(body))).toBe("é");
    expect(body.locked).toBe(false);
  });

  test("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const body = source(["a", "b", "c"], () => (cancelled = true));

    for await (const chunk of decodeChunks(body)) {
      expect(chunk).toBe("a");
      break;
    }

    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("cancels the body when the consumer throws at a chunk", async () => {
    let cancelled = false;
    const body = source(["a", "b"], () => (cancelled = true));

    await expect(
      (async () => {
        for await (const _ of decodeChunks(body)) throw new Error("consumer failed");
      })(),
    ).rejects.toThrow("consumer failed");

    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("does not cancel a body that was read to the end", async () => {
    let cancelled = false;
    const body = source(["a", "b"], () => (cancelled = true));

    expect(await collect(decodeChunks(body))).toBe("ab");
    expect(cancelled).toBe(false);
  });

  test("a failed read surfaces once, with nothing left unhandled", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) controller.enqueue(encoder.encode("a"));
        else controller.error(new Error("socket closed"));
      },
    });

    await expect(collect(decodeChunks(body))).rejects.toThrow("socket closed");
    await settle();
    expect(body.locked).toBe(false);
    expect(unhandled).toEqual([]);
  });

  test("a `closed` rejected by the release is handled (Bun's 'Reader released')", async () => {
    const { body, calls } = bunLikeBody([encoder.encode("a")]);

    expect(await collect(decodeChunks(body))).toBe("a");
    await settle();

    expect(calls.release).toBe(1);
    expect(unhandled).toEqual([]);
  });

  test("an early stop on a Bun-like reader cancels, releases and leaves nothing unhandled", async () => {
    const { body, calls } = bunLikeBody([encoder.encode("a"), encoder.encode("b")]);

    for await (const _ of decodeChunks(body)) break;
    await settle();

    expect(calls).toEqual({ cancel: 1, release: 1 });
    expect(unhandled).toEqual([]);
  });

  test("a release that throws does not replace how the stream ended", async () => {
    const { body } = bunLikeBody([encoder.encode("a")], { releaseThrows: true });

    expect(await collect(decodeChunks(body))).toBe("a");
    await settle();
    expect(unhandled).toEqual([]);
  });
});
