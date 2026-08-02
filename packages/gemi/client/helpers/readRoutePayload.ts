/** One streamed query result: `[path, variantKey, data]`. */
export type RouteQueryPayload = [string, string, any];

/**
 * Reads a navigation payload response (#290).
 *
 * The body is NDJSON: the first line is the envelope (route data, meta,
 * partial info, already-resolved `prefetchedData`), later lines are
 * `[path, variantKey, data]` query results streamed as they settle
 * server-side. The returned promise resolves with the envelope as soon as
 * its line arrives — the caller commits the navigation immediately — while
 * the remaining lines keep draining in the background into `onQueryPayload`,
 * whose `hydrate()` settles any segment that suspended on that variant.
 *
 * Tolerates two other body shapes so every producer keeps working: a plain
 * single-JSON body with no trailing newline (error-path responses, buffering
 * proxies) parses as the envelope at end-of-stream, and a `Response` without
 * a readable `body` (test doubles) falls back to `.json()`.
 */
export async function readRoutePayload(
  response: Response,
  onQueryPayload?: (payload: RouteQueryPayload) => void,
): Promise<any | null> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const decoder = new TextDecoder();
  let buffer = "";

  return await new Promise<any | null>((resolve) => {
    let envelopeResolved = false;
    const emitEnvelope = (value: any | null) => {
      if (envelopeResolved) return;
      envelopeResolved = true;
      resolve(value);
    };

    const handleLine = (line: string) => {
      if (line.trim().length === 0) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        console.error("[gemi] Unparseable route payload line", error);
        emitEnvelope(null);
        return;
      }
      if (!envelopeResolved) {
        emitEnvelope(value);
        return;
      }
      if (Array.isArray(value) && value.length === 3) {
        onQueryPayload?.(value as RouteQueryPayload);
      }
    };

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            handleLine(line);
            newline = buffer.indexOf("\n");
          }
        }
        buffer += decoder.decode();
        // A plain-JSON body has no trailing newline: the whole buffer is the
        // envelope. (For NDJSON bodies the buffer is empty here.)
        handleLine(buffer);
        emitEnvelope(null);
      } catch (error) {
        console.error("[gemi] Route payload stream failed", error);
        emitEnvelope(null);
      }
    })();
  });
}

/**
 * Reads the response to the very end and returns the envelope with every
 * streamed query result merged into its `prefetchedData` — the settled
 * aggregate a `<Link prefetch>` warms ahead of a click, equivalent to what
 * the old blocking payload contained. Buffering is the point here: a hover
 * prefetch has time, and the cache stores one complete payload.
 */
export async function readSettledRoutePayload(
  response: Response,
): Promise<any | null> {
  if (typeof response.text !== "function") {
    // Test doubles that only implement `.json()`.
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  let envelope: any;
  try {
    envelope = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  for (const line of lines.slice(1)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(value) && value.length === 3) {
      const [path, variantKey, data] = value as RouteQueryPayload;
      envelope.prefetchedData ??= {};
      envelope.prefetchedData[path] ??= {};
      envelope.prefetchedData[path][variantKey] = data;
    }
  }
  return envelope;
}
