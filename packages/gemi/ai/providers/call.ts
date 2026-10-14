import type { ProviderEvent } from "../AgentProvider";
import type { ProviderTarget } from "./endpoints";
import { httpErrorDetail, normalizeProviderError } from "./errors";
import {
  MAX_FILE_REJECTION_RETRIES,
  rejectedFileIds,
  withoutFiles,
  type SentFile,
} from "./fileRejection";
import { addUsage, isContentEvent } from "../runtime";
import type { AgentError, Usage } from "../types";
import {
  backoffDelayMs,
  requestWithRetry,
  waitUnlessAborted,
  type FetchLike,
  type RequestOptions,
} from "./http";
import type { ResponsesRequest } from "./request";
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
  maxRetries: number;
  fetchImpl?: FetchLike;
  /** Injected by the tests, with `random`, so a backoff can be asserted on
   *  without waiting for it. See `RequestOptions`. */
  sleep?: RequestOptions["sleep"];
  random?: () => number;
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
    maxRetries: target.maxRetries,
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
 */
export async function* streamResponses(
  endpoint: ResponsesEndpoint,
  body: ResponsesRequest,
  params: {
    signal?: AbortSignal;
    structuredOutput: boolean;
    /** The file ids `body` sends, with their names — for the note that
     *  replaces a file the provider refuses. See `providers/fileRejection.ts`. */
    files?: Map<string, SentFile>;
  },
): AsyncGenerator<ProviderEvent> {
  let request = body;
  const rejected = new Set<string>();
  let fileAttempts = 0;
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
  const aborted = (): ProviderEvent => closing({ type: "finish", reason: "aborted", usage: emptyUsage() });

  for (let streamAttempt = 0; ; streamAttempt++) {
    let response: Response | undefined;
    while (response === undefined) {
      try {
        response = await requestWithRetry(
          endpoint.responsesUrl,
          {
            method: "POST",
            headers: { ...(await endpoint.headers()), "content-type": "application/json" },
            body: JSON.stringify(request),
          },
          {
            maxRetries: endpoint.maxRetries,
            timeoutMs: endpoint.timeoutMs,
            signal: params.signal,
            fetchImpl: endpoint.fetchImpl,
            sleep: endpoint.sleep,
            random: endpoint.random,
          },
        );
      } catch (error) {
        // A stored file the provider will not read fails this request and, left
        // in, every later one in the thread (#684). Take it out and ask again,
        // as long as the error blames a file this attempt still sent.
        const blamed =
          fileAttempts < MAX_FILE_REJECTION_RETRIES
            ? rejectedFileIds(request, error, params.files).filter((id) => !rejected.has(id))
            : [];
        if (blamed.length > 0) {
          fileAttempts++;
          const reason = normalizeProviderError(error).message;
          for (const fileId of blamed) {
            rejected.add(fileId);
            yield { type: "file-rejected", fileId, message: reason, ...httpErrorDetail(error) };
          }
          request = withoutFiles(request, new Set(blamed), params.files);
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
    try {
      for await (const event of parseResponsesStream(decodeChunks(response.body), {
        structuredOutput: params.structuredOutput,
      })) {
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
    } catch (error) {
      const normalized = normalizeProviderError(error);
      if (normalized.code === "aborted" || params.signal?.aborted) {
        yield aborted();
        return;
      }
      if (committed) {
        yield { type: "error", error: normalized };
        yield closing({ type: "finish", reason: "error", usage: emptyUsage() });
        return;
      }
      failure = normalized;
      held.push(
        { type: "error", error: normalized },
        { type: "finish", reason: "error", usage: emptyUsage() },
      );
    }
    if (committed) return;

    if (failure?.retryable && streamAttempt < maxStreamRetries && !params.signal?.aborted) {
      for (const event of held) {
        if (event.type === "finish") dropped = addUsage(dropped ?? emptyUsage(), event.usage);
      }
      try {
        await waitUnlessAborted(backoffDelayMs(streamAttempt, random), params.signal, endpoint.sleep);
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
  purpose: UploadPurpose = "user_data",
): Promise<string> {
  const form = new FormData();
  form.set("purpose", purpose);
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
