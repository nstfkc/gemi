import { RequestBreakerError } from "./Error";

/**
 * A request body over its route's limit (#752): a 413 in the usual refusal
 * shape, `{ error: { kind: "form_error", message, status: 413 } }`, so a
 * `<FormError>` shows it like any other message about the request.
 */
export class PayloadTooLargeError extends RequestBreakerError {
  constructor(public limit: number) {
    super("The request body is too large.", { status: 413 });
  }
}

const UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/**
 * `"64kb"`, `"1.5mb"`, `"512"` or a number, as bytes; units are binary
 * (`1kb` is 1024 bytes) and case-insensitive. `"none"` (or `"off"`) is no
 * limit, for a route that must lift a lower app-wide default. Anything else
 * throws: a limit that silently read as "no limit" would be worse than none.
 */
export function parseByteSize(input: string | number): number {
  if (typeof input === "number") {
    if (Number.isFinite(input) && input >= 0) return Math.floor(input);
    if (input === Infinity) return Infinity;
  } else {
    const value = input.trim().toLowerCase();
    if (value === "none" || value === "off") return Infinity;
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(value);
    if (match && (match[2] === "" || match[2] in UNITS)) {
      return Math.floor(Number(match[1]) * (UNITS[match[2]] ?? 1));
    }
  }
  throw new Error(
    `Invalid body limit ${JSON.stringify(input)}. Use a byte count or a size such as "64kb", "1mb" or "none".`,
  );
}

interface LimitState {
  limit: number;
  /** Bytes the limited stream has handed out so far. */
  read: number;
  /** The limited body, created on first access; `null` for a bodiless request. */
  stream: ReadableStream<Uint8Array> | null | undefined;
  /** Whether one of the read methods (`text()`, `formData()`, …) consumed it. */
  used: boolean;
}

const states = new WeakMap<Request, LimitState>();

/** Whether a body limit is installed on `request`, by a middleware or the default. */
export function hasBodyLimit(request: Request): boolean {
  return states.has(request);
}

/** The limit installed on `request`, or `null` when there is none. */
export function bodyLimitOf(request: Request): number | null {
  return states.get(request)?.limit ?? null;
}

/** Whether reading `request`'s body ran past its limit. */
export function bodyLimitExceeded(request: Request): boolean {
  const state = states.get(request);
  return state ? state.read > state.limit : false;
}

function declaredLength(request: Request): number | null {
  const header = request.headers.get("Content-Length");
  if (header === null || !/^\s*\d+\s*$/.test(header)) return null;
  return Number(header);
}

function refuseDeclaredLength(request: Request, limit: number) {
  const length = declaredLength(request);
  if (length !== null && length > limit) {
    throw new PayloadTooLargeError(limit);
  }
}

/**
 * Bounds what can be read of `request`'s body to `limit` bytes.
 *
 * A declared `Content-Length` over the limit is refused at once (unless
 * `checkDeclared` is false, as for the app-wide default, which a route's own
 * `body-limit` may still raise), and again when the body is read. A body
 * without one — chunked — is counted as it streams and refused with a 413 the
 * moment it passes the limit; nothing beyond `limit` bytes is ever buffered.
 *
 * The Request keeps its identity, which the request's other state is keyed
 * on: the body accessors (`body`, `text()`, `json()`, `formData()`,
 * `arrayBuffer()`, `bytes()`, `blob()`, `clone()`) are shadowed on the
 * instance, so `req.input()`, `req.rawRequest.text()` and a proxy route's
 * forwarded stream all read through the same counter.
 *
 * Installing again replaces the limit, so a route's `body-limit` overrides its
 * router's, and either overrides the app-wide default.
 */
export function setBodyLimit(
  request: Request,
  limit: number,
  options: { checkDeclared?: boolean } = {},
) {
  const existing = states.get(request);
  if (existing) {
    existing.limit = limit;
  } else {
    const state: LimitState = { limit, read: 0, stream: undefined, used: false };
    states.set(request, state);
    shadowBodyAccessors(request, state);
  }
  if (options.checkDeclared !== false) {
    refuseDeclaredLength(request, limit);
  }
}

function nativeBody(request: Request): ReadableStream<Uint8Array> | null {
  return Reflect.get(Object.getPrototypeOf(request), "body", request) ?? null;
}

function limitedStream(request: Request, state: LimitState) {
  if (state.stream !== undefined) return state.stream;
  const source = nativeBody(request);
  if (!source) return (state.stream = null);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  state.stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // The source is locked on the first pull, not when `body` is first
        // touched: a logger that only looks at `req.rawRequest.body` must not
        // start reading it.
        reader ??= source.getReader();
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        state.read += value.byteLength;
        if (state.read > state.limit) {
          const err = new PayloadTooLargeError(state.limit);
          controller.error(err);
          reader.cancel(err).catch(() => {});
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader ? reader.cancel(reason) : source.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return state.stream;
}

async function readAll(request: Request, state: LimitState): Promise<Uint8Array> {
  // Checked at read time too, for a limit installed with `checkDeclared: false`.
  refuseDeclaredLength(request, state.limit);
  if (state.used || state.stream?.locked) {
    throw new TypeError("Body already used");
  }
  state.used = true;
  const stream = limitedStream(request, state);
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function contentType(request: Request) {
  return request.headers.get("Content-Type") ?? "";
}

function shadowBodyAccessors(request: Request, state: LimitState) {
  const define = (name: string, descriptor: PropertyDescriptor) =>
    Object.defineProperty(request, name, { configurable: true, ...descriptor });

  define("body", { get: () => limitedStream(request, state) });
  define("bodyUsed", {
    get: () =>
      state.used ||
      Boolean(state.stream?.locked) ||
      (Reflect.get(Object.getPrototypeOf(request), "bodyUsed", request) as boolean),
  });
  define("bytes", { value: () => readAll(request, state) });
  define("arrayBuffer", {
    value: async () => {
      const bytes = await readAll(request, state);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  });
  define("text", {
    value: async () => new TextDecoder().decode(await readAll(request, state)),
  });
  define("json", {
    value: async () => JSON.parse(new TextDecoder().decode(await readAll(request, state))),
  });
  define("blob", {
    value: async () =>
      new Blob([(await readAll(request, state)) as BlobPart], { type: contentType(request) }),
  });
  define("formData", {
    value: async () =>
      new Response((await readAll(request, state)) as BodyInit, {
        headers: { "Content-Type": contentType(request) },
      }).formData(),
  });
  define("clone", {
    value: () => {
      refuseDeclaredLength(request, state.limit);
      const stream = limitedStream(request, state);
      let body: ReadableStream<Uint8Array> | null = null;
      if (stream) {
        // Both halves are fed by the one counter, so a clone is no way around it.
        const [own, copy] = stream.tee();
        state.stream = own;
        body = copy;
      }
      return new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
        // @ts-expect-error `duplex` is required by fetch for a stream body but
        // missing from the DOM lib's RequestInit.
        duplex: "half",
      });
    },
  });
}
