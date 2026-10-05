/**
 * A subscription's position: the last seq it delivered of each channel,
 * written as a query string, `site%3A42=17&site%3A43=4`.
 *
 * One string for every channel of a stream, because it travels as the SSE
 * event `id`, and the browser sends back only the last one as
 * `Last-Event-ID`. Readable in a network panel, and safe in a header.
 */
export type ChangeFeedCursor = ReadonlyMap<string, number>;

export function encodeCursor(positions: ChangeFeedCursor): string {
  const params = new URLSearchParams();
  for (const [channel, seq] of positions) params.append(channel, String(seq));
  return params.toString();
}

/**
 * The positions a cursor holds. A malformed one, or one whose seq is not a
 * whole number of 0 or more, is left out: a channel without a position starts
 * from its head, which is what a client with no usable cursor should get.
 */
export function decodeCursor(cursor: string | null | undefined): Map<string, number> {
  const positions = new Map<string, number>();
  if (!cursor) return positions;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(cursor);
  } catch {
    return positions;
  }
  for (const [channel, value] of params) {
    const seq = Number(value);
    if (value !== "" && Number.isSafeInteger(seq) && seq >= 0) positions.set(channel, seq);
  }
  return positions;
}
