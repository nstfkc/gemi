import type { ProviderEvent } from "../AgentProvider";
import { normalizeProviderError } from "./errors";
import { requestWithRetry, type FetchLike } from "./http";
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
};

/**
 * Errors reach the consumer as events, not exceptions.
 *
 * A `ProviderStream` that threw would make every caller wrap its `for await`,
 * and would lose the deltas already yielded — the agent needs the text it got
 * before the socket died, because the user has already read it.
 */
export async function* streamResponses(
  endpoint: ResponsesEndpoint,
  body: ResponsesRequest,
  params: { signal?: AbortSignal; structuredOutput: boolean },
): AsyncGenerator<ProviderEvent> {
  let response: Response;
  try {
    response = await requestWithRetry(
      endpoint.responsesUrl,
      {
        method: "POST",
        headers: { ...(await endpoint.headers()), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      {
        maxRetries: endpoint.maxRetries,
        timeoutMs: endpoint.timeoutMs,
        signal: params.signal,
        fetchImpl: endpoint.fetchImpl,
      },
    );
  } catch (error) {
    const normalized = normalizeProviderError(error);
    // An abort is not a failure to report: the run was stopped on purpose, and
    // `Agent` is already writing the ending. Saying so twice would put an error
    // in a transcript the user closed themselves.
    if (normalized.code !== "aborted") yield { type: "error", error: normalized };
    yield {
      type: "finish",
      reason: normalized.code === "aborted" ? "aborted" : "error",
      usage: emptyUsage(),
    };
    return;
  }

  try {
    yield* parseResponsesStream(decodeChunks(response.body), {
      structuredOutput: params.structuredOutput,
    });
  } catch (error) {
    const normalized = normalizeProviderError(error);
    if (normalized.code === "aborted") {
      yield { type: "finish", reason: "aborted", usage: emptyUsage() };
      return;
    }
    yield { type: "error", error: normalized };
    yield { type: "finish", reason: "error", usage: emptyUsage() };
  }
}

/**
 * Uploads an attachment and returns the id a `FilePart` carries.
 *
 * `user_data` rather than `assistants`: this is a file a person attached to a
 * message, not a corpus for a retrieval store, and the purpose is what decides
 * which of the two the file can be used for.
 */
export async function uploadFile(endpoint: ResponsesEndpoint, file: File): Promise<string> {
  const form = new FormData();
  form.set("purpose", "user_data");
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
