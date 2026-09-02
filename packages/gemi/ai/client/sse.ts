import type { AgentStreamFrame, ToolShapes } from "../types";

/**
 * Bytes to frames.
 *
 * Split out of the hook because none of it is React: it is a byte-level parser,
 * and the interesting cases — a chunk boundary landing inside a `data:` line, a
 * multi-byte character split across two reads, a stream that dies mid-event —
 * are all reachable from a test with a string and no DOM.
 *
 * Deliberately not `EventSource`. The agent routes are POSTs carrying a turn,
 * `EventSource` can only GET, and reattachment wants the cursor in the request
 * body next to the thread id rather than in a header the browser owns.
 */

/**
 * Feed it chunks, get frames. Holds whatever is left over between calls, which
 * is the whole point: `push()` is called once per `reader.read()` and those
 * boundaries have nothing to do with event boundaries.
 */
export class SSEFrameDecoder<T extends ToolShapes = ToolShapes, O = unknown> {
  private buffer = "";
  private textDecoder = new TextDecoder();
  /**
   * A `\r` at the very end of a chunk is ambiguous — the next chunk may open
   * with the `\n` that completes a CRLF, or with the next line. Holding it back
   * for one chunk is what keeps a boundary there from being read as a blank
   * line and cutting an event in half.
   */
  private pendingCR = false;
  private lastSeq = -1;

  /** The cursor to resume from: the highest `id:` seen. */
  get cursor(): number {
    return this.lastSeq;
  }

  push(chunk: Uint8Array | string): AgentStreamFrame<T, O>[] {
    this.append(
      typeof chunk === "string" ? chunk : this.textDecoder.decode(chunk, { stream: true }),
    );
    return this.drain();
  }

  /**
   * End of stream. Anything still buffered is an event with no terminating
   * blank line, which the SSE spec discards and so does this — a truncated tail
   * is usually truncated JSON, and half a `text-delta` appended to a message is
   * worse than a missing one.
   */
  flush(): AgentStreamFrame<T, O>[] {
    this.append(this.textDecoder.decode());
    const frames = this.drain();
    this.buffer = "";
    this.pendingCR = false;
    return frames;
  }

  /** Normalises every line ending to `\n` so the rest of the parser only has to
   *  know about one. */
  private append(text: string) {
    if (text === "") return;
    let rest = text;
    if (this.pendingCR) {
      this.buffer += "\n";
      this.pendingCR = false;
      if (rest.startsWith("\n")) rest = rest.slice(1);
    }
    if (rest.endsWith("\r")) {
      rest = rest.slice(0, -1);
      this.pendingCR = true;
    }
    this.buffer += rest.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  private drain(): AgentStreamFrame<T, O>[] {
    const frames: AgentStreamFrame<T, O>[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = this.parse(block);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  private parse(block: string): AgentStreamFrame<T, O> | null {
    let id: string | undefined;
    const data: string[] = [];

    for (const line of block.split("\n")) {
      // A comment. The server sends these as keepalives through a proxy that
      // would otherwise close an idle connection, and they carry nothing.
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
      // `event:` and `retry:` are read and dropped: the frame's own `type` is
      // the discriminator, so a second one on the transport could only disagree
      // with it.
    }

    if (data.length === 0) return null;

    let event: AgentStreamFrame<T, O>["event"];
    try {
      // Multi-line data rejoins with `\n`, per the spec — which is also what
      // makes a pretty-printed JSON payload survive the transport.
      event = JSON.parse(data.join("\n"));
    } catch {
      // One unparseable frame must not take the rest of the run with it.
      return null;
    }

    const parsed = id === undefined || id === "" ? Number.NaN : Number(id);
    // A frame with no usable `id` still needs a seq, because seq is what makes
    // a replayed frame a no-op downstream. Continuing the count is the reading
    // that keeps the cursor monotone; treating it as 0 would make every such
    // frame look already-applied.
    const seq = Number.isFinite(parsed) ? parsed : this.lastSeq + 1;
    this.lastSeq = seq;
    return { seq, event };
  }
}

/**
 * The same decoder over a `Response.body`.
 *
 * Cancels the reader when the caller stops consuming — a `break` out of the
 * `for await` is how the hook drops a stream on unmount, and without the cancel
 * the connection stays open behind it.
 */
export async function* decodeSSE<T extends ToolShapes = ToolShapes, O = unknown>(
  stream: ReadableStream<Uint8Array> | null | undefined,
): AsyncGenerator<AgentStreamFrame<T, O>, void, void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new SSEFrameDecoder<T, O>();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        yield* decoder.flush();
        return;
      }
      if (value) yield* decoder.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already errored or already closed; there is nothing left to release.
    }
  }
}
