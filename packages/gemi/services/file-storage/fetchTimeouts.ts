import type { IFileStorageDriver, FetchFileOptions, ReadFileParams } from "./drivers/types";

/** Which of the two `Storage.fetch()` limits fired. */
export type StorageFetchTimeoutLimit = "fetchTimeoutMs" | "fetchIdleTimeoutMs";

/**
 * A `Storage.fetch()` without a caller `signal` ran into one of the default
 * limits. With `limit: "fetchTimeoutMs"` it rejects `fetch()` itself (no
 * response in time); with `limit: "fetchIdleTimeoutMs"` it errors the body
 * (no bytes for that long while the reader waited). Either way the request
 * was aborted, so the connection is released.
 */
export class StorageFetchTimeoutError extends Error {
  readonly code = "storage-fetch-timeout";

  constructor(
    /** The driver's class name, e.g. `AzureBlobDriver`. */
    readonly driver: string,
    readonly limit: StorageFetchTimeoutLimit,
    readonly timeoutMs: number,
    /** The object being read. */
    readonly object: string,
  ) {
    super(
      limit === "fetchTimeoutMs"
        ? `${driver}: no response for "${object}" within ${timeoutMs}ms (fetchTimeoutMs)`
        : `${driver}: the body of "${object}" sent nothing for ${timeoutMs}ms (fetchIdleTimeoutMs)`,
    );
    this.name = "StorageFetchTimeoutError";
  }
}

export interface FetchTimeouts {
  /** Time until the driver hands back a response. `0` turns it off. */
  fetchTimeoutMs: number;
  /** Longest wait for the next body chunk while the reader waits. `0` turns it off. */
  fetchIdleTimeoutMs: number;
}

/**
 * `driver.fetch()`, bounded by `limits` when the caller passed no signal of
 * its own. A caller's signal wins and turns both limits off.
 *
 * The driver gets an internal signal, so a limit that fires aborts the request
 * in the SDK and cancels the body, which releases the socket. The facade does
 * not rely on that alone: a driver that ignores the signal still has its
 * promise or body cut here.
 */
export async function fetchWithTimeouts(
  driver: IFileStorageDriver,
  params: ReadFileParams | string,
  options: FetchFileOptions,
  limits: FetchTimeouts,
): Promise<Response> {
  const responseMs = limits.fetchTimeoutMs;
  const idleMs = limits.fetchIdleTimeoutMs;
  if (options.signal || (!responseMs && !idleMs)) {
    return driver.fetch(params, options);
  }

  const controller = new AbortController();
  const driverName = driver.constructor?.name || "FileStorageDriver";
  const object = typeof params === "string" ? params : params.name;
  const timeout = (limit: StorageFetchTimeoutLimit, ms: number) => {
    const error = new StorageFetchTimeoutError(driverName, limit, ms, object);
    controller.abort(error);
    return error;
  };

  const pending = Promise.resolve(
    driver.fetch(params, { ...options, signal: controller.signal }),
  );

  let response: Response;
  if (responseMs) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeout("fetchTimeoutMs", responseMs)), responseMs);
    });
    try {
      response = await Promise.race([pending, timedOut]);
    } catch (error) {
      if (controller.signal.aborted) {
        // A driver that ignored the signal may still resolve later: drop its
        // body so the connection is not held open.
        pending.then(
          (late) => late.body?.cancel(controller.signal.reason).catch(() => {}),
          () => {},
        );
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } else {
    response = await pending;
  }

  if (!idleMs || !response.body) {
    return response;
  }

  return new Response(
    idleTimeoutBody(response.body, idleMs, () => timeout("fetchIdleTimeoutMs", idleMs)),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

/**
 * Errors the stream when a read from `body` waits longer than `ms`. The clock
 * runs only while the consumer is waiting on the source, so a consumer that
 * reads slowly (a slow client downloading the response) is never cut, and a
 * large file on a slow but steady link is not either: every chunk resets it.
 */
function idleTimeoutBody(
  body: ReadableStream<Uint8Array>,
  ms: number,
  onIdle: () => Error,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut: Error | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = onIdle();
            reject(timedOut);
          }, ms);
        });
        try {
          const chunk = await Promise.race([reader.read(), idle]);
          if (chunk.done) {
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          // The abort in `onIdle` can error the source first, with whatever
          // the driver or SDK throws on abort; the timeout is the real cause.
          const reason = timedOut ?? error;
          controller.error(reason);
          reader.cancel(reason).catch(() => {});
        } finally {
          clearTimeout(timer);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    // Pull only on demand, so the idle clock never runs ahead of the consumer.
    { highWaterMark: 0 },
  );
}
