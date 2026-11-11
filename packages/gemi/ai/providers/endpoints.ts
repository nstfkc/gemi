/**
 * Where a vendor lives, and who we are to it — resolved once, for every kind of
 * call.
 *
 * WHY THIS IS ITS OWN MODULE. The Responses path and the images path differ only
 * in the last segment of the URL. Everything before it — which host, whether the
 * configured endpoint already carried `/openai`, whether the api-version is
 * dated and therefore routes to the older path, whether to send `authorization:
 * Bearer` or `api-key`, whether an Entra token has to be minted again because
 * the last one expired mid-conversation — is identical, and every line of it was
 * worked out by measuring a real resource rather than reading documentation (the
 * transcripts are on `azureBase` below).
 *
 * That is exactly the kind of knowledge that must not be copied. A second copy
 * in an image provider would be correct on the day it was written and would
 * drift on the first fix that only one of them got, and the symptom of the drift
 * is a 404 on every request for whichever apps configured the provider the
 * documented way — which is the bug `azureBase` exists because of.
 *
 * So a provider resolves a `ProviderTarget` and appends its own path. Nothing
 * here knows about Responses, files or images.
 */

export type ProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  /**
   * The longest a streamed answer may go without sending anything (an event or
   * a keepalive) once its response has started. Every chunk resets it. When it
   * runs out the attempt is aborted with a retryable `ProviderTimeoutError`:
   * before the first content event it is asked again like any other dropped
   * stream, after it the call ends with an error. Default
   * `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (120 s); `0` turns it off.
   */
  streamIdleTimeoutMs?: number;
  /**
   * The longest one attempt's stream may run, from its response headers to its
   * last event, however steadily it keeps sending (#1169). No chunk resets it.
   * When it runs out the attempt is aborted with a retryable `provider_error`.
   * Default `DEFAULT_STREAM_MAX_DURATION_MS` (300 s); `0` turns it off.
   */
  streamMaxDurationMs?: number;
  /**
   * The most argument text one tool call may stream without finishing (#1169),
   * in characters. Past it the attempt is aborted with a retryable
   * `provider_error`, as a runaway generation. Default `0`, off: how large a
   * legitimate call gets depends entirely on the app's tools.
   */
  maxToolArgumentChars?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
};

export type AzureConfig = ProviderConfig & {
  /**
   * The resource host, with or without a trailing `/openai`. Both spellings
   * work — `https://<resource>.cognitiveservices.azure.com` and
   * `https://<resource>.openai.azure.com` — and neither is rewritten, because
   * only one of them exists for a resource that was not created as
   * kind=OpenAI. See `azureBase` for what is done to it.
   */
  endpoint?: string;
  /**
   * Just the resource name, when there is no endpoint to hand. `<name>` is
   * expanded to `https://<name>.cognitiveservices.azure.com/openai`.
   */
  resourceName?: string;
  apiVersion?: string;
  /**
   * The deployment to call, when it is not named after the model. Azure lets
   * whoever ran the template call it anything, and plenty of them are called
   * `prod` — this is the override the class comment promises.
   */
  deployment?: string;
  /**
   * For Entra ID instead of a key. A function, not a token, because these
   * expire mid-conversation.
   */
  getToken?: () => Promise<string>;
};

/**
 * A resolved vendor, ready for a path to be appended.
 *
 * `base` and `query` are separate because Azure's api-version is a query
 * parameter and a caller appending `/images/generations` must not have to know
 * that it goes *before* the `?`. Every URL is `${base}${path}${query}`.
 */
export type ProviderTarget = {
  /** e.g. `https://api.openai.com/v1`, or `https://<host>/openai/v1`. */
  base: string;
  /** e.g. `` or `?api-version=preview`. Already encoded. */
  query: string;
  /** Called per request. See the Azure branch for why that is not an accident. */
  headers: () => Promise<Record<string, string>>;
  timeoutMs: number;
  /** See `ProviderConfig.streamIdleTimeoutMs`. `0` is off. */
  streamIdleTimeoutMs: number;
  /** See `ProviderConfig.streamMaxDurationMs`. `0` is off. */
  streamMaxDurationMs: number;
  /** See `ProviderConfig.maxToolArgumentChars`. `0` is off. */
  maxToolArgumentChars: number;
  maxRetries: number;
};

/** Long enough for a reasoning model to think before it says anything, short
 *  enough that a hung connection is not mistaken for a slow one. For a streamed
 *  call it only covers getting a response; the stream that follows is bounded
 *  by `streamIdleTimeoutMs` instead. For a one-shot call it is the whole deadline — which is why the
 *  images path sets its own, and why `retryTimeouts` exists. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;

/**
 * How long a streamed answer may stay silent once it has started (#1167).
 *
 * `timeoutMs` stops at the response headers, and a Responses stream sends its
 * headers (and `response.created`) within a second or so, so before this
 * nothing bounded a stream that went quiet: a stalled step waited for the
 * run's `maxRunDurationMs`. Seen on an Azure deployment: completed steps took
 * 1–12 s with the first event after 1–5 s, and the one that stalled sent
 * nothing more for ten minutes.
 *
 * WHY NOT SHORTER. The cost of the two mistakes is not symmetric. Too long, and
 * a rare stall takes two minutes to notice instead of one. Too short, and a
 * reasoning model at a high effort, which can think for a long while between
 * two events, is cut off mid-thought on every hard request, retried (and billed)
 * up to `maxRetries` times, and fails anyway. So the default matches the
 * header timeout, which already had to be long enough for a model to think
 * before saying anything. An app on low effort can set it lower.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * How long one attempt's stream may run in all, however steadily it sends
 * (#1169).
 *
 * `streamIdleTimeoutMs` cannot see a stream that keeps trickling: seen on an
 * Azure deployment, one function call whose argument deltas kept coming for
 * 500 s (1,228 deltas against 20–60 normally), each one resetting the idle
 * clock, until the run's `maxRunDurationMs` ended the whole run. Completed
 * calls of the same agent took 4 s at p50 and 43 s at most.
 *
 * WHY 300 S. The same asymmetry as the idle limit, sharper. A limit that cuts a
 * legitimate call does not just cost a retry: the retry is the same long call
 * and is cut again, so a request that used to work now always fails. Five
 * minutes leaves room for a reasoning model at a high effort that thinks for
 * minutes before writing, and for a long answer or a large tool call (about
 * 15–30k output tokens at common streaming rates). And it is half the default
 * `maxRunDurationMs` (ten minutes), so a run that hits a runaway early still
 * has the time to ask again and finish. An app whose calls are short (a low
 * reasoning effort, small tools) can set it much lower.
 */
export const DEFAULT_STREAM_MAX_DURATION_MS = 300_000;

export function env(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.[name];
}

/**
 * `preview` selects Azure's `/openai/v1` surface, which is the OpenAI-shaped
 * one — same request body, same SSE frames, same `model` field naming the
 * deployment — and it is the only surface the Responses API has that gemi's
 * request builder can talk to unchanged. It takes no dated version: sending
 * `api-version=2025-04-01-preview` to `/openai/v1/responses` answers
 * `400 {"code":"BadRequest","message":"API version not supported"}`.
 *
 * A dated version is still honoured, and routes to the older
 * `/openai/responses` path instead — see `azurePath`. So an app that pinned
 * one keeps working, which is the promise the old comment here made and could
 * not keep once the paths diverged.
 */
export const AZURE_API_VERSION = "preview";

/**
 * Where an Azure call goes, worked out live rather than from docs.
 *
 * THE PROBLEM THIS SOLVES. `AZURE_OPENAI_ENDPOINT` is conventionally written
 * with `/openai` already on the end, and the old code appended `/openai` again
 * and then a deployment path, producing
 * `…/openai/openai/deployments/<dep>/responses` — a 404 on every request, for
 * every app that configured the provider the documented way. Two separate
 * mistakes were stacked there, and only measuring told them apart.
 *
 * WHAT WAS MEASURED, against a real resource, POSTing a Responses body:
 *
 *   404  {endpoint}/openai/deployments/gpt-5.4/responses?api-version=2025-04-01-preview
 *   404  {host}/openai/deployments/gpt-5.4/responses?api-version=2025-04-01-preview
 *   404  {host}/openai/deployments/gpt-5.4/responses?api-version=preview
 *   400  {host}/openai/v1/responses?api-version=2025-04-01-preview   ("API version not supported")
 *   200  {host}/openai/v1/responses?api-version=preview
 *   200  {host}/openai/v1/responses                                   (no api-version at all)
 *   200  {host}/openai/responses?api-version=2025-04-01-preview
 *
 * for {host} in BOTH `https://<resource>.cognitiveservices.azure.com` and
 * `https://<resource>.openai.azure.com` — both spellings answered identically,
 * so the host was never the variable. The deployment-in-the-URL path is the
 * Chat Completions shape and the Responses API does not serve it at all; the
 * deployment goes in the body's `model`, which is what `buildResponsesRequest`
 * already puts there.
 *
 * `/openai/v1/files?api-version=preview` and
 * `/openai/files?api-version=2025-04-01-preview` were both checked too (200,
 * empty list), so uploads follow the same fork.
 *
 * And so do images, measured the same way against a `gpt-image-2` deployment:
 *
 *   200  {host}/openai/v1/images/generations?api-version=preview
 *   200  {host}/openai/v1/images/edits?api-version=preview
 *
 * which is the whole reason this function is shared rather than reimplemented.
 */
export function azureBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // A configured endpoint may or may not already carry `/openai`, and may even
  // carry `/openai/v1` if someone copied a full URL. Normalize down to the
  // resource base and put exactly one `/openai` back, rather than appending
  // blind — appending blind is the bug.
  const base = trimmed.replace(/\/openai(?:\/v1)?$/i, "");
  return `${base}/openai`;
}

/** Dated versions belong to the older path; `preview` (and anything that is not
 *  a date) belongs to `/v1`. Both were verified above. */
export function azurePath(apiVersion: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(apiVersion) ? "" : "/v1";
}

/** Overrides for a call whose deadline is not a streaming handshake's. */
export type TargetDefaults = { timeoutMs?: number };

export function openAITarget(
  config: ProviderConfig,
  defaults: TargetDefaults = {},
): ProviderTarget {
  const base = (config.baseURL ?? env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );

  return {
    base,
    query: "",
    headers: async () => {
      const apiKey = config.apiKey ?? env("OPENAI_API_KEY");
      return {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...config.headers,
      };
    },
    timeoutMs: config.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    streamMaxDurationMs: config.streamMaxDurationMs ?? DEFAULT_STREAM_MAX_DURATION_MS,
    maxToolArgumentChars: config.maxToolArgumentChars ?? 0,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * The resource base, `<host>/openai`, from whichever of the three ways it was
 * configured. A bare resource name expands to the `cognitiveservices` host
 * rather than the `openai.azure.com` one: both answer for a resource created
 * as kind=OpenAI, only `cognitiveservices` answers for an AI Foundry or
 * multi-service resource, so it is the spelling that is right more often. An
 * app on the other one sets `endpoint` and nothing rewrites it.
 */
export function azureResourceBase(config: AzureConfig): string {
  const configured = config.baseURL ?? config.endpoint ?? env("AZURE_OPENAI_ENDPOINT");
  if (configured) return azureBase(configured);
  const resource =
    config.resourceName ?? env("AZURE_OPENAI_RESOURCE_NAME") ?? env("AZURE_RESOURCE_NAME");
  return resource ? azureBase(`https://${resource.trim()}.cognitiveservices.azure.com`) : "";
}

export function azureTarget(config: AzureConfig, defaults: TargetDefaults = {}): ProviderTarget {
  const apiVersion = config.apiVersion ?? env("AZURE_OPENAI_API_VERSION") ?? AZURE_API_VERSION;

  return {
    base: `${azureResourceBase(config)}${azurePath(apiVersion)}`,
    query: `?api-version=${encodeURIComponent(apiVersion)}`,
    headers: async () => {
      // Called per request, not per provider: an Entra token minted when the
      // app booted is expired by the time a long conversation reaches step
      // nine, and that failure looks like a random 401 in the middle of a
      // working feature.
      if (config.getToken) {
        return { authorization: `Bearer ${await config.getToken()}`, ...config.headers };
      }
      const apiKey = config.apiKey ?? env("AZURE_OPENAI_API_KEY");
      return { ...(apiKey ? { "api-key": apiKey } : {}), ...config.headers };
    },
    timeoutMs: config.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    streamMaxDurationMs: config.streamMaxDurationMs ?? DEFAULT_STREAM_MAX_DURATION_MS,
    maxToolArgumentChars: config.maxToolArgumentChars ?? 0,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * The Messages API version sent as `anthropic-version`. `2026-10-21` is the
 * version the current SDKs send: on it `temperature`, `top_p` and `top_k` are a
 * 400 on every model, which is why `buildMessagesRequest` never sends them.
 */
export const ANTHROPIC_VERSION = "2026-10-21";

/**
 * Anthropic's API, `https://api.anthropic.com` unless `baseURL` (or
 * `ANTHROPIC_BASE_URL`) names a gateway in front of it. The base is the host,
 * as the SDKs take it; a trailing `/v1` is accepted too and not doubled.
 *
 * Authenticates with `x-api-key` (`apiKey`, else `ANTHROPIC_API_KEY`), or
 * with `ANTHROPIC_AUTH_TOKEN` as a bearer when there is no key (the SDKs'
 * order), read per request like the others.
 */
export function anthropicTarget(config: ProviderConfig, defaults: TargetDefaults = {}): ProviderTarget {
  const host = (config.baseURL ?? env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");

  return {
    base: `${host}/v1`,
    query: "",
    headers: async () => {
      const apiKey = config.apiKey ?? env("ANTHROPIC_API_KEY");
      const token = apiKey ? undefined : env("ANTHROPIC_AUTH_TOKEN");
      return {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "anthropic-version": ANTHROPIC_VERSION,
        ...config.headers,
      };
    },
    timeoutMs: config.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    streamMaxDurationMs: config.streamMaxDurationMs ?? DEFAULT_STREAM_MAX_DURATION_MS,
    maxToolArgumentChars: config.maxToolArgumentChars ?? 0,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * Azure's realtime surface, which is the GA `/openai/v1` one regardless of the
 * configured api-version.
 *
 * WHY NOT `azureTarget`. A dated api-version routes `azureTarget` to the older
 * `/openai/...` path (see `azurePath`), and that path has no `realtime/calls`:
 * the WebRTC "unified interface", the client secrets and the call's sideband
 * socket are documented on `/openai/v1/realtime/...` only, and the documented
 * URLs carry no `api-version` at all. An app that pinned a dated version for
 * its Responses calls must not lose voice for it, so this target ignores the
 * version and keeps everything else — the resource base and, above all, the
 * per-request credential — from the one place that resolves them.
 *
 * NOT YET MEASURED against a real Azure realtime deployment (there was none to
 * measure when this was written). The shape follows Azure's GA realtime
 * documentation; when a deployment exists, the transcripts belong here as they
 * do on `azureBase`.
 */
export function azureRealtimeTarget(
  config: AzureConfig,
  defaults: TargetDefaults = {},
): ProviderTarget {
  const target = azureTarget(config, defaults);
  return { ...target, base: `${azureResourceBase(config)}/v1`, query: "" };
}
