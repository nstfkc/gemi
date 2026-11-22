import { Log } from "../../facades/Log";
import type { ProviderEvent } from "../AgentProvider";
import type { ProviderTarget } from "./endpoints";
import {
  httpErrorDetail,
  ProviderHttpError,
  normalizeProviderError,
  ProviderStreamDurationError,
  ProviderStreamIdleError,
  ProviderTimeoutError,
  ProviderToolArgumentsRunawayError,
  ProviderToolArgumentsTooLongError,
} from "./errors";
import {
  MAX_FILE_REJECTION_RETRIES,
  rejectedFileIds,
  withoutFiles,
  type SentFile,
} from "./fileRejection";
import { addUsage, isContentEvent } from "../runtime";
import type { AgentError, ProviderErrorDetail, ToolArgumentsTooLong, Usage } from "../types";
import {
  backoffDelayMs,
  boundedBody,
  requestWithRetry,
  waitUnlessAborted,
  type FetchLike,
  type RequestOptions,
  patienceApplies,
  patientDelayMs,
  type ProviderRetryPolicy,
} from "./http";
import type { ResponsesRequest } from "./request";
import { withoutStaleReasoning } from "./staleReasoning";
import { decodeChunks, emptyUsage, parseResponsesStream } from "./stream";

/**
 * The parts of a call that differ between OpenAI and Azure, and nothing else.
 *
 * Two classes, one request path: the differences are a URL, a header and when
 * the credential is read, so those are what gets passed in. Everything below
 * this line — retries, decoding, event translation, what an error looks like —
 * is identical, and duplicating it into the Azure class is how the two would
 * start behaving differently by accident.
 */
export type ResponsesEndpoint = {
  responsesUrl: string;
  filesUrl: string;
  /** Async because Entra tokens expire mid-conversation, so the credential has
   *  to be read per request rather than per provider. */
  headers: () => Promise<Record<string, string>>;
  timeoutMs: number;
  /** See `ProviderConfig.streamIdleTimeoutMs`. Absent or `0` is off. */
  streamIdleTimeoutMs?: number;
  /** See `ProviderConfig.streamMaxDurationMs`. Absent or `0` is off. */
  streamMaxDurationMs?: number;
  /** See `ProviderConfig.maxToolArgumentChars`. Absent or `0` is off. */
  maxToolArgumentChars?: number;
  /** See `ProviderConfig.maxToolArgumentWhitespace`. Absent or `0` is off. */
  maxToolArgumentWhitespace?: number;
  maxRetries: number;
  /** See `ProviderConfig.retry`. */
  retry?: ProviderRetryPolicy;
  fetchImpl?: FetchLike;
  /** Injected by the tests, with `random`, so a backoff can be asserted on
   *  without waiting for it. See `RequestOptions`. */
  sleep?: RequestOptions["sleep"];
  random?: () => number;
  now?: () => number;
};

/**
 * The Responses paths for a resolved vendor.
 *
 * The two URLs are all that distinguishes this from any other call to the same
 * host, which is why the host, the credential and the api-version are worked out
 * by `providers/endpoints.ts` and appended to here rather than resolved twice.
 * Files are resource-scoped rather than deployment-scoped on Azure — an upload
 * is not addressed to a model — and the deployment goes in the body's `model`,
 * which `buildResponsesRequest` already does.
 */
export function responsesEndpoint(target: ProviderTarget): ResponsesEndpoint {
  return {
    responsesUrl: `${target.base}/responses${target.query}`,
    filesUrl: `${target.base}/files${target.query}`,
    headers: target.headers,
    timeoutMs: target.timeoutMs,
    streamIdleTimeoutMs: target.streamIdleTimeoutMs,
    streamMaxDurationMs: target.streamMaxDurationMs,
    maxToolArgumentChars: target.maxToolArgumentChars,
    maxToolArgumentWhitespace: target.maxToolArgumentWhitespace,
    maxRetries: target.maxRetries,
    ...(target.retry ? { retry: target.retry } : {}),
  };
}

/**
 * Errors reach the consumer as events, not exceptions.
 *
 * A `ProviderStream` that threw would make every caller wrap its `for await`,
 * and would lose the deltas already yielded — the agent needs the text it got
 * before the socket died, because the user has already read it.
 *
 * A STREAM THAT DIES BEFORE ITS FIRST CONTENT EVENT IS ASKED AGAIN (#946).
 * `requestWithRetry` covers a request that fails before a response arrives;
 * this covers the one whose response started and then broke while its body was
 * being read: the socket closed, the stream ended with no terminal frame, or
 * the provider sent a `response.failed` / `error` frame that reads as
 * retryable. Measured in fager: one such drop on the first step lost a whole
 * build, and the same request a second later worked.
 *
 * Nothing the user could have seen is repeated. Until the first content event
 * (`isContentEvent`) the only things a Responses stream yields are an error and
 * a finish, and those are held back; from the first content event on, the call
 * is committed and a later failure ends it as before. The retries use the
 * endpoint's `maxRetries` and the same backoff as the request retry, and an
 * abort during the wait ends the call at once. The usage a dropped attempt
 * reported is added to the call's closing `finish`, because it was billed.
 *
 * A STREAM THAT GOES SILENT IS CUT (#1167). With `streamIdleTimeoutMs` set, a
 * body that sends nothing for that long errors with a `ProviderStreamIdleError`
 * and the attempt's request is aborted, which releases the socket. From there it
 * is a broken stream like any other: retryable, so asked again before the first
 * content event, and the call's error after it (nothing is repeated). The
 * caller's signal still wins: an abort while waiting ends the call as aborted.
 *
 * A STREAM THAT KEEPS TRICKLING IS CUT TOO (#1169). `streamMaxDurationMs`
 * bounds an attempt's stream by the wall clock, which no chunk resets, and
 * `maxToolArgumentChars` bounds the argument text of one unfinished tool call.
 * Both abort the attempt with a retryable error, like the idle limit.
 *
 * A CALL THAT RUNS AWAY IN WHITE SPACE ENDS AT ONCE (#1334). With
 * `maxToolArgumentWhitespace` set, a tool call whose arguments end in a longer
 * run of white space outside strings has stopped writing, whatever it keeps
 * streaming. If its arguments are whole JSON, the attempt is aborted and the
 * call is finished as written: a `tool-call` with the trimmed arguments, then
 * a `stop` finish with the usage the stream had reported so far (none, on the
 * Responses API, where it comes with the terminal frame). Otherwise it is cut
 * like a call past `maxToolArgumentChars`, with a
 * `ProviderToolArgumentsRunawayError` whose detail carries `whitespace`.
 * Either way one warning is logged.
 *
 * AN ATTEMPT THAT STREAMED ONLY UNFINISHED TOOL-CALL ARGUMENTS IS NOT
 * COMMITTED (#1169). `tool-call-delta` is yielded as it arrives, so a UI can
 * show a call filling in, but until a text, reasoning, output, tool-search or
 * completed `tool-call` event the attempt can still be asked again: the call
 * never completed and never ran, so nothing the model said has been acted on.
 * Before the retry a `tool-call-discard` event names the partial calls, so
 * the consumer drops them; the next attempt's calls get new ids. Any retryable
 * break counts, not only the limits above. Once retries are spent, the partial
 * calls stay and the call ends with the error, as before.
 */
export async function* streamResponses<Body extends object = ResponsesRequest>(
  endpoint: ResponsesEndpoint,
  body: Body,
  params: {
    signal?: AbortSignal;
    structuredOutput: boolean;
    /** See `ProviderStreamParams.retryToolArgumentsTooLong`. */
    retryToolArgumentsTooLong?: boolean;
    /** The file ids `body` sends, with their names — for the note that
     *  replaces a file the provider refuses. See `providers/fileRejection.ts`.
     *  Responses bodies only: without it a refused file fails the call. */
    files?: Map<string, SentFile>;
    /**
     * The SSE parser. Defaults to the Responses one; the Anthropic provider
     * passes `parseMessagesStream`, and everything else here (retries, the
     * stream limits, holding back until the first content event) is shared.
     */
    parse?: (
      chunks: AsyncIterable<string>,
      options: { structuredOutput: boolean; onUsage?: (usage: Usage) => void },
    ) => AsyncIterable<ProviderEvent>;
  },
): AsyncGenerator<ProviderEvent> {
  const parse = params.parse ?? parseResponsesStream;
  let request = body;
  const rejected = new Set<string>();
  let fileAttempts = 0;
  // Once per call: see `providers/staleReasoning.ts`.
  let reasoningStripped = false;
  const maxStreamRetries = Math.max(0, endpoint.maxRetries);
  const random = endpoint.random ?? Math.random;
  // What the attempts that were dropped before their first content event
  // reported as used. Folded into whichever `finish` closes the call.
  let dropped: Usage | undefined;
  const closing = (event: Extract<ProviderEvent, { type: "finish" }>): ProviderEvent => {
    if (!dropped) return event;
    const usage = addUsage(addUsage(emptyUsage(), dropped), event.usage);
    dropped = undefined;
    return { ...event, usage };
  };
  // With what the attempt used so far (#1353): a stopped call is billed too.
  const aborted = (usage?: Usage): ProviderEvent =>
    closing({ type: "finish", reason: "aborted", usage: usage ?? emptyUsage() });
  /** What the call has used, the dropped attempts' and this one's so far. */
  const soFar = (usage: Usage): Usage => addUsage(addUsage(emptyUsage(), dropped ?? emptyUsage()), usage);

  const idleMs = endpoint.streamIdleTimeoutMs ?? 0;
  const maxMs = endpoint.streamMaxDurationMs ?? 0;
  const maxArgs = endpoint.maxToolArgumentChars ?? 0;
  const maxSpace = endpoint.maxToolArgumentWhitespace ?? 0;
  const now = endpoint.now ?? Date.now;
  const startedAt = now();

  for (let streamAttempt = 0; ; streamAttempt++) {
    // Per attempt, so an idle timeout can abort this attempt's request (and
    // release its socket) without touching the caller's signal.
    const attempt = new AbortController();
    const signal = params.signal ? AbortSignal.any([params.signal, attempt.signal]) : attempt.signal;
    let response: Response | undefined;
    while (response === undefined) {
      try {
        // The request retries inside `requestWithRetry`, and its `retry`
        // events are yielded as they happen, not after it settles: they exist
        // to say the call is waiting, while it is (#1192).
        const retries: ProviderEvent[] = [];
        let wake: () => void = () => {};
        const pending = requestWithRetry(
          endpoint.responsesUrl,
          {
            method: "POST",
            headers: { ...(await endpoint.headers()), "content-type": "application/json" },
            body: JSON.stringify(request),
          },
          {
            maxRetries: endpoint.maxRetries,
            timeoutMs: endpoint.timeoutMs,
            signal,
            fetchImpl: endpoint.fetchImpl,
            sleep: endpoint.sleep,
            random: endpoint.random,
            now: endpoint.now,
            startedAt,
            ...(endpoint.retry ? { retry: endpoint.retry } : {}),
            onRetry: (info) => {
              retries.push({ type: "retry", ...info, phase: "request" });
              wake();
            },
          },
        );
        const settled = pending.then(
          () => true,
          () => true,
        );
        for (;;) {
          const woken = new Promise<false>((resolve) => (wake = () => resolve(false)));
          const done = await Promise.race([settled, woken]);
          yield* retries.splice(0);
          if (done) break;
        }
        response = await pending;
      } catch (error) {
        // A stored file the provider will not read fails this request and, left
        // in, every later one in the thread (#684). Take it out and ask again,
        // as long as the error blames a file this attempt still sent.
        const responses = request as unknown as ResponsesRequest;
        const blamed =
          params.files && fileAttempts < MAX_FILE_REJECTION_RETRIES
            ? rejectedFileIds(responses, error, params.files).filter((id) => !rejected.has(id))
            : [];
        if (blamed.length > 0) {
          fileAttempts++;
          const reason = normalizeProviderError(error).message;
          for (const fileId of blamed) {
            rejected.add(fileId);
            yield { type: "file-rejected", fileId, message: reason, ...httpErrorDetail(error) };
          }
          request = withoutFiles(responses, new Set(blamed), params.files) as unknown as Body;
          continue;
        }
        // A replayed reasoning item the API no longer has fails this request
        // and every later one in the thread. Asked again once without the
        // reasoning items, which the answer does not depend on.
        const stripped = reasoningStripped ? null : withoutStaleReasoning(request, error);
        if (stripped) {
          reasoningStripped = true;
          request = stripped as unknown as Body;
          continue;
        }
        const normalized = normalizeProviderError(error);
        // An abort is not a failure to report: the run was stopped on purpose, and
        // `Agent` is already writing the ending. Saying so twice would put an error
        // in a transcript the user closed themselves.
        if (normalized.code === "aborted") {
          yield aborted();
          return;
        }
        yield { type: "error", error: normalized, ...httpErrorDetail(error) };
        yield closing({ type: "finish", reason: "error", usage: emptyUsage() });
        return;
      }
    }

    const held: ProviderEvent[] = [];
    let committed = false;
    let failure: AgentError | undefined;
    let streamTimedOut = false;
    // The call this attempt was cut at, when `maxToolArgumentChars` ended it.
    let cut: ToolArgumentsTooLong | undefined;
    // The tool calls this attempt has yielded argument deltas for, with how
    // much text each has streamed. Before `committed`, these are the only
    // things the consumer has seen, and a retry discards them.
    const partial = new Map<string, ArgumentScan>();
    // The usage the stream reported so far: for a call ended as a runaway,
    // cut, broken or stopped (#1353), and for the `usage` events.
    let usageSoFar: Usage | undefined;
    // The whole call's, as `usage` and the closing `finish` count it.
    const withUsage = (): { usage?: Usage } => (usageSoFar ? { usage: soFar(usageSoFar) } : {});
    // A runaway call whose arguments were whole JSON, finished as written.
    let finished: Extract<ProviderEvent, { type: "tool-call" }> | undefined;
    try {
      const body = boundedBody(
        response.body,
        { idleMs, maxMs },
        {
          idle: () => {
            const error = new ProviderStreamIdleError(idleMs);
            attempt.abort(error);
            return error;
          },
          max: () => {
            const error = new ProviderStreamDurationError(maxMs);
            attempt.abort(error);
            return error;
          },
        },
      );
      for await (const event of parse(decodeChunks(body), {
        structuredOutput: params.structuredOutput,
        onUsage: (usage) => (usageSoFar = usage),
      })) {
        // The parser's count is this attempt's; the call's includes the
        // attempts dropped before it. Sent at once, committed or not: it
        // replaces rather than adds, and a dropped attempt is billed anyway,
        // so a consumer that stops before the first content (the whole input
        // is billed by then) still holds the count.
        if (event.type === "usage") {
          usageSoFar = event.usage;
          yield { type: "usage", usage: soFar(event.usage) };
          continue;
        }
        if (event.type === "tool-call-delta") {
          let scan = partial.get(event.toolCallId);
          if (!scan) partial.set(event.toolCallId, (scan = newScan()));
          scanArguments(scan, event.argsDelta, maxSpace > 0);
          const chars = scan.chars;
          if (maxSpace > 0 && scan.space > maxSpace) {
            const args = scan.text.trimEnd();
            const whole = isJson(args);
            warnRunaway(event.name, event.toolCallId, chars, scan.space, maxSpace, whole);
            if (!whole) {
              const error = new ProviderToolArgumentsRunawayError(
                maxSpace,
                event.name,
                event.toolCallId,
                chars,
                scan.space,
              );
              attempt.abort(error);
              throw error;
            }
            partial.delete(event.toolCallId);
            finished = {
              type: "tool-call",
              toolCallId: event.toolCallId,
              name: event.name,
              args,
              ...(event.namespace ? { namespace: event.namespace } : {}),
            };
            break;
          }
          if (maxArgs > 0 && chars > maxArgs) {
            const error = new ProviderToolArgumentsTooLongError(
              maxArgs,
              event.name,
              event.toolCallId,
              chars,
            );
            attempt.abort(error);
            throw error;
          }
          yield event;
          continue;
        }
        if (event.type === "tool-call") partial.delete(event.toolCallId);
        if (committed) {
          yield event.type === "finish" ? closing(event) : event;
          continue;
        }
        if (isContentEvent(event)) {
          committed = true;
          yield* held.splice(0);
          yield event;
          continue;
        }
        if (event.type === "error") failure = event.error;
        held.push(event);
      }
      // Let go of the runaway's body (the loop released its lock), so the
      // provider stops sending whatever the fetch does with the abort below.
      if (finished) await body?.cancel().catch(() => {});
    } catch (error) {
      streamTimedOut = error instanceof ProviderTimeoutError;
      const normalized = normalizeProviderError(error);
      if (normalized.code === "aborted" || params.signal?.aborted) {
        yield aborted(usageSoFar);
        return;
      }
      if (error instanceof ProviderToolArgumentsTooLongError) cut = error.detail;
      if (committed) {
        // The cut call is named after earlier content too (#1326), so the agent
        // can answer it with the tool's error. A committed attempt is never
        // asked again, so `retryToolArgumentsTooLong` does not apply here.
        yield { type: "error", error: normalized, ...(cut ? { toolArgumentsTooLong: cut } : {}), ...withUsage() };
        yield closing({ type: "finish", reason: "error", usage: usageSoFar ?? emptyUsage() });
        return;
      }
      failure = normalized;
      held.push(
        { type: "error", error: normalized, ...(cut ? { toolArgumentsTooLong: cut } : {}), ...withUsage() },
        { type: "finish", reason: "error", usage: usageSoFar ?? emptyUsage() },
      );
    }
    if (finished) {
      // The runaway call, finished as written: content, so it commits the
      // attempt, and the answer ends with it. Calls still streaming beside it
      // never finished and are taken back. The loop has let go of the body;
      // the abort releases the connection.
      attempt.abort();
      if (!committed) yield* held.splice(0);
      yield finished;
      if (partial.size > 0) yield { type: "tool-call-discard", toolCallIds: [...partial.keys()] };
      yield closing({ type: "finish", reason: "stop", usage: usageSoFar ?? emptyUsage() });
      return;
    }
    if (committed) return;

    let detail: ProviderErrorDetail = {};
    for (const event of held) if (event.type === "error") detail = httpErrorDetail(event);
    // Past `maxRetries`, a patience budget asks again too (#1258), for the
    // failures its `on` names (#1291). A cut call the caller sends back to the
    // model itself is not asked again at all: the same request comes out as
    // long again, which is what the limit is there to stop.
    const delayMs =
      !failure?.retryable || params.signal?.aborted || (cut && params.retryToolArgumentsTooLong === false)
        ? undefined
        : streamAttempt < maxStreamRetries
          ? backoffDelayMs(streamAttempt, random)
          : endpoint.retry &&
              patienceApplies(endpoint.retry, failure, {
                ...(detail.status !== undefined ? { status: detail.status } : {}),
                timedOut: streamTimedOut,
                ...(cut ? { toolArgumentsTooLong: cut } : {}),
              })
            ? patientDelayMs(
                endpoint.retry,
                streamAttempt - maxStreamRetries,
                failure.retryAfter,
                now() - startedAt,
                random,
              )
            : undefined;
    if (delayMs !== undefined) {
      let attemptUsage: Usage | undefined;
      for (const event of held) {
        if (event.type === "finish") attemptUsage = addUsage(attemptUsage ?? emptyUsage(), event.usage);
      }
      if (attemptUsage) dropped = addUsage(dropped ?? emptyUsage(), attemptUsage);
      const used = attemptUsage && attemptUsage.totalTokens > 0 ? { usage: attemptUsage } : {};
      if (partial.size > 0) yield { type: "tool-call-discard", toolCallIds: [...partial.keys()] };
      const elapsedMs = now() - startedAt;
      yield {
        type: "retry",
        attempt: streamAttempt + 1,
        maxRetries: maxStreamRetries,
        error: failure,
        ...detail,
        ...used,
        phase: "stream",
        timedOut: streamTimedOut,
        ...(cut ? { toolArgumentsTooLong: cut } : {}),
        delayMs,
        elapsedMs,
        ...(endpoint.retry
          ? { remainingMs: Math.max(0, endpoint.retry.patienceMs - elapsedMs - delayMs) }
          : {}),
      };
      // What the call has used, dropped attempts included, for a consumer
      // that stops during the wait: the next attempt's count starts again.
      if (dropped && dropped.totalTokens > 0) yield { type: "usage", usage: soFar(emptyUsage()) };
      try {
        await waitUnlessAborted(delayMs, params.signal, endpoint.sleep);
      } catch {
        yield aborted();
        return;
      }
      continue;
    }

    for (const event of held) yield event.type === "finish" ? closing(event) : event;
    return;
  }
}

/** One tool call's arguments as they stream in, read just far enough to tell
 *  white space inside a string from white space between tokens (#1334). */
type ArgumentScan = {
  chars: number;
  /** The arguments so far; kept only while `maxToolArgumentWhitespace` is on. */
  text: string;
  inString: boolean;
  escaped: boolean;
  /** The run of white space outside strings the arguments end in. */
  space: number;
};

function newScan(): ArgumentScan {
  return { chars: 0, text: "", inString: false, escaped: false, space: 0 };
}

function scanArguments(scan: ArgumentScan, delta: string, track: boolean): void {
  scan.chars += delta.length;
  if (!track) return;
  scan.text += delta;
  for (const ch of delta) {
    if (scan.inString) {
      if (scan.escaped) scan.escaped = false;
      else if (ch === "\\") scan.escaped = true;
      else if (ch === '"') scan.inString = false;
    } else if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      scan.space++;
      continue;
    } else if (ch === '"') {
      scan.inString = true;
    }
    scan.space = 0;
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** One structured warning per runaway call, through the app's logger when
 *  there is one, as the agent's own warnings are. */
function warnRunaway(
  tool: string,
  toolCallId: string,
  chars: number,
  whitespace: number,
  limit: number,
  whole: boolean,
): void {
  const message = `[gemi/ai] tool call "${tool}" ran away in white space (more than ${limit} characters, maxToolArgumentWhitespace); ${
    whole ? "its arguments were whole JSON, so it was finished as written" : "its arguments were not whole JSON, so it was cut"
  }`;
  const metadata = { tool, toolCallId, chars, whitespace, limit, whole };
  let logged = false;
  try {
    Log.warning(message, metadata);
    logged = true;
  } catch {
    // No application to resolve a logger from.
  }
  if (!logged || process.env.NODE_ENV === "development") console.warn(message, metadata);
}

/**
 * What a file is uploaded *for*, which decides where its id is accepted.
 *
 * The two providers disagree, and each refuses the other's answer.
 *
 * OpenAI: `user_data`. This is a file a person attached to a message, not a
 * corpus for a retrieval store, and the purpose is what decides which of the
 * two the file can be used for.
 *
 * Azure: `assistants`. MEASURED (gpt-6-sol deployment, `/openai/v1`,
 * `api-version=preview`, 2026-10-01, #682): Azure accepts a `user_data` upload
 * and answers a `file-…` id, and then its Responses API refuses that id in both
 * `input_file` and `input_image` with `400 Invalid
 * 'input[0].content[0].file_id': 'file-…'. Expected an ID that begins with
 * 'assistant'.` The same files uploaded as `assistants` come back as
 * `assistant-…` ids (`expires_at: null`) and work: pdf, txt, md and csv as
 * `input_file`, png as `input_image` with real vision.
 */
export type UploadPurpose = "user_data" | "assistants";

/**
 * Uploads an attachment and returns the id a `FilePart` carries.
 *
 * The purpose is the caller's because it is a property of the provider, not of
 * the file — see `UploadPurpose`.
 */
export async function uploadFile(
  endpoint: ResponsesEndpoint,
  file: File,
  /** `null` for Anthropic's Files API, which takes no purpose. */
  purpose: UploadPurpose | null = "user_data",
): Promise<string> {
  const form = new FormData();
  if (purpose) form.set("purpose", purpose);
  form.set("file", file);

  const response = await requestWithRetry(
    endpoint.filesUrl,
    {
      method: "POST",
      // No content-type: the boundary is generated with the body, and setting
      // the header by hand is how multipart uploads fail with a parser error
      // that names nothing useful.
      headers: await endpoint.headers(),
      body: form,
    },
    {
      maxRetries: endpoint.maxRetries,
      timeoutMs: endpoint.timeoutMs,
      fetchImpl: endpoint.fetchImpl,
    },
  );

  const json = (await response.json()) as { id?: string };
  if (!json?.id) throw new Error("The provider accepted the upload but returned no file id.");
  return json.id;
}

/**
 * Deletes a file `uploadFile` sent (#1165): `DELETE {base}/files/{id}{query}`,
 * with the same resolved host, headers and api-version as the upload, so the
 * URL is built from `filesUrl` rather than worked out again.
 *
 * A 404 resolves: the file is already gone (deleted earlier, expired at the
 * vendor, or a retried delete whose first answer was lost), which is the state
 * the caller asked for.
 */
export async function deleteFile(endpoint: ResponsesEndpoint, fileId: string): Promise<void> {
  const at = endpoint.filesUrl.indexOf("?");
  const path = at === -1 ? endpoint.filesUrl : endpoint.filesUrl.slice(0, at);
  const query = at === -1 ? "" : endpoint.filesUrl.slice(at);
  try {
    const response = await requestWithRetry(
      `${path}/${encodeURIComponent(fileId)}${query}`,
      { method: "DELETE", headers: await endpoint.headers() },
      {
        maxRetries: endpoint.maxRetries,
        timeoutMs: endpoint.timeoutMs,
        fetchImpl: endpoint.fetchImpl,
        ...(endpoint.sleep ? { sleep: endpoint.sleep } : {}),
        ...(endpoint.random ? { random: endpoint.random } : {}),
      },
    );
    await response.body?.cancel();
  } catch (error) {
    if (error instanceof ProviderHttpError && error.status === 404) return;
    throw error;
  }
}
