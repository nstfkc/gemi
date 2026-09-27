import type { AgentError, Usage } from "../types";
import type { ProviderTarget } from "./endpoints";
import { normalizeProviderError } from "./errors";
import { requestWithRetry, type FetchLike } from "./http";

/**
 * One image call, retried where retrying is free and not where it costs a render.
 *
 * MEASURED against a `gpt-image-2` deployment, api-version `preview`, and every
 * decision in this file comes from one of these rather than from documentation —
 * which disagreed with the endpoint on three separate points:
 *
 *   200  {base}/images/generations   low,  1024x1024, png                   15.0s
 *   200  {base}/images/generations   low,  1024x1024, png, transparent      14.6s
 *   400  {base}/images/generations   high, 1536x1024, webp
 *          → "Invalid value: 'webp'. Supported values are: 'png' and 'jpeg'."
 *   200  {base}/images/generations   high, 1536x1024, png                  117.8s
 *   200  {base}/images/edits         low,  one image[], no mask, no size     13.7s
 *          → answered size "1254x1254", which is neither what was asked for
 *            nor a multiple of 16
 *   200  {base}/images/edits         low,  one image[], mask, 1024x1024      14.0s
 *   200  {base}/images/edits         low,  two image[], 1024x1024            20.2s
 *
 * The documentation was wrong that `webp` is accepted, wrong that this model
 * cannot do transparency, and wrong about the `usage` field names. The response
 * shape, verbatim:
 *
 *   { "created": 1790519365, "background": "opaque", "output_format": "png",
 *     "quality": "low", "size": "1024x1024",
 *     "data": [{ "b64_json": "…" }],
 *     "usage": { "input_tokens": 15,
 *                "input_tokens_details":  { "image_tokens": 0,   "text_tokens": 15 },
 *                "output_tokens": 196,
 *                "output_tokens_details": { "image_tokens": 196, "text_tokens": 0 },
 *                "total_tokens": 211 } }
 *
 * There is no `revised_prompt` in any of the five successful responses. See
 * `ImageModel` for why the field is not on the public result type.
 */
export type ImagesEndpoint = {
  generationsUrl: string;
  editsUrl: string;
  /** Async for the same reason the Responses endpoint's is: Entra tokens expire
   *  mid-conversation, so the credential is read per request. */
  headers: () => Promise<Record<string, string>>;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchLike;
};

/**
 * Longer than the Responses default, because here the timer bounds the work.
 *
 * A `high` / 1536x1024 render measured 117.8 seconds against a 120_000 default —
 * two seconds of headroom. That is not a timeout, it is a coin flip, and losing
 * it used to mean three renders billed (see `RequestOptions.retryTimeouts`). 300
 * seconds is chosen to clear the measured worst case with room for a busier
 * resource and a larger size, and an app that knows its own ceiling sets
 * `timeoutMs` in config.
 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000;

export function imagesEndpoint(target: ProviderTarget): ImagesEndpoint {
  return {
    generationsUrl: `${target.base}/images/generations${target.query}`,
    editsUrl: `${target.base}/images/edits${target.query}`,
    headers: target.headers,
    timeoutMs: target.timeoutMs,
    maxRetries: target.maxRetries,
  };
}

/**
 * What an image call failed with, as a normalized code rather than a vendor body.
 *
 * A one-shot call throws where the streaming path emits an `error` event — a
 * promise has nowhere else to put it, and a caller awaiting bytes should not have
 * to check a union. The normalized `AgentError` is carried so an app can branch
 * on `rate_limited` exactly as it would for a text call.
 *
 * The vendor's own body is on `cause` and deliberately NOT in `message`. Inside a
 * tool a throw becomes a tool result the model reads (#446), and a provider error
 * body is not something to hand a model verbatim when a sentence will do.
 */
export class ImageRequestError extends Error {
  readonly code: AgentError["code"];
  readonly retryable: boolean;

  constructor(error: AgentError, options: { cause?: unknown } = {}) {
    super(error.message, options);
    this.name = "ImageRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

/** The JSON body of a generation. Vendor field names, built by `ImageModel`. */
export type ImageGenerationRequest = {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
};

/** What every image call answers, before `ImageModel` gives it a public shape. */
export type ImageResponse = {
  /** Decoded from `b64_json`. */
  bytes: Uint8Array;
  mimeType: string;
  /** Read off the response, never assumed — an edit with no `size` answered
   *  `1254x1254`. */
  size: string;
  background?: string;
  usage: Usage;
};

const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
};

/**
 * The vendor's `usage` onto gemi's.
 *
 * Separate from `toUsage` in `stream.ts` rather than shared with it. The three
 * totals have the same names, so sharing looked right; the details objects do
 * not. `toUsage` reads `output_tokens_details.reasoning_tokens` and
 * `input_tokens_details.cached_tokens`, and this endpoint sends `image_tokens`
 * and `text_tokens` in both — so reusing it silently discards the only part of
 * this payload that is specific to images, which is the part `imageInputTokens`
 * exists for.
 */
export function toImageUsage(raw: any): Usage {
  const inputTokens = Number(raw?.input_tokens ?? 0);
  const outputTokens = Number(raw?.output_tokens ?? 0);
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: Number(raw?.total_tokens ?? inputTokens + outputTokens),
  };
  const inImages = raw?.input_tokens_details?.image_tokens;
  if (typeof inImages === "number") usage.imageInputTokens = inImages;
  const outImages = raw?.output_tokens_details?.image_tokens;
  if (typeof outImages === "number") usage.imageOutputTokens = outImages;
  return usage;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseImageResponse(json: any): ImageResponse {
  const first = json?.data?.[0];
  const b64 = first?.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    // Not an assertion for its own sake: the endpoint has a `url` response mode
    // for other models, and a deployment that answered with one would otherwise
    // reach the caller as an empty Blob.
    throw new ImageRequestError({
      code: "provider_error",
      message: "The provider answered an image call with no base64 image data.",
      retryable: false,
    });
  }

  const format = typeof json.output_format === "string" ? json.output_format : "png";
  return {
    bytes: decodeBase64(b64),
    mimeType: MIME_BY_FORMAT[format] ?? `image/${format}`,
    size: typeof json.size === "string" ? json.size : "",
    ...(typeof json.background === "string" ? { background: json.background } : {}),
    usage: toImageUsage(json.usage),
  };
}

type CallOptions = { signal?: AbortSignal };

async function post(
  url: string,
  init: RequestInit,
  endpoint: ImagesEndpoint,
  options: CallOptions,
): Promise<ImageResponse> {
  let response: Response;
  try {
    response = await requestWithRetry(url, init, {
      maxRetries: endpoint.maxRetries,
      timeoutMs: endpoint.timeoutMs,
      // The whole point. A timeout here means the render probably happened and
      // we hung up; retrying pays for it again. 429 and 5xx are still retried.
      retryTimeouts: false,
      signal: options.signal,
      fetchImpl: endpoint.fetchImpl,
    });
  } catch (error) {
    // An abort is the caller's own doing and must stay recognisable as one —
    // `stop()` is not a provider failure.
    if (options.signal?.aborted) throw error;
    throw new ImageRequestError(normalizeProviderError(error), { cause: error });
  }

  return parseImageResponse(await response.json());
}

export async function generateImage(
  endpoint: ImagesEndpoint,
  body: ImageGenerationRequest,
  options: CallOptions = {},
): Promise<ImageResponse> {
  return await post(
    endpoint.generationsUrl,
    {
      method: "POST",
      headers: { ...(await endpoint.headers()), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    endpoint,
    options,
  );
}

/**
 * An edit, as multipart.
 *
 * `image[]` repeated once per input, measured — two parts reported 2048 input
 * image tokens against 1024 for one. No `content-type` header, for the reason
 * `uploadFile` gives: the boundary is generated with the body, and setting the
 * header by hand fails with a parser error that names nothing useful.
 */
export async function editImage(
  endpoint: ImagesEndpoint,
  form: FormData,
  options: CallOptions = {},
): Promise<ImageResponse> {
  return await post(
    endpoint.editsUrl,
    { method: "POST", headers: await endpoint.headers(), body: form },
    endpoint,
    options,
  );
}
