/**
 * Ties a response body to an `AbortSignal`, so aborting after `fetch()` has
 * resolved still reaches a caller that is reading the body.
 *
 * Handing the signal to the SDK is not enough on its own: once the headers are
 * back, whether an abort also errors the body stream depends on the SDK and
 * the runtime, and a caller parked in `arrayBuffer()` must not hang. So on
 * abort the returned stream errors with the signal's reason, and the source
 * stream is cancelled, which releases the file handle or the connection.
 *
 * The abort listener is removed once the body finishes, errors or is
 * cancelled, so a long-lived signal (a request's, say) does not collect one
 * listener per read.
 */
export function abortableBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  if (!signal) {
    return body;
  }

  const reader = body.getReader();
  let settled = false;
  let onAbort: (() => void) | undefined;

  const detach = () => {
    settled = true;
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        onAbort = () => {
          if (settled) return;
          detach();
          controller.error(signal.reason);
          reader.cancel(signal.reason).catch(() => {});
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      },
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (settled) return;
          detach();
          controller.error(err);
          return;
        }
        // An abort that landed while the read was pending has already
        // errored the stream, and a cancelled reader resolves `done`.
        if (settled) return;
        if (chunk.done) {
          detach();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        detach();
        return reader.cancel(reason);
      },
    },
    // Pull only on demand, so nothing is read ahead of the consumer.
    { highWaterMark: 0 },
  );
}
