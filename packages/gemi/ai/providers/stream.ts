import type { ProviderEvent } from "../AgentProvider";
import type { Usage } from "../types";

/**
 * The Responses SSE stream to `ProviderEvent`.
 *
 * Also a pure function over chunks, for the same reason the request builder is:
 * everything that breaks here breaks on a byte boundary or a malformed frame,
 * and neither needs a network to reproduce. The tests drive it with recorded
 * fixture strings, including one fed a byte at a time.
 */

export type SSEMessage = { event: string; data: string; id?: string };

/**
 * Chunks to SSE messages.
 *
 * Written out rather than reached for as a one-liner because every shortcut
 * here is a bug that only shows up under load. A frame split across two chunks
 * is the normal case, not the edge case — TCP has no idea what an event is.
 * Multi-line `data:` is spec, comment lines beginning with `:` are what
 * keepalives look like, and a `\r\n` stream is what you get through some
 * proxies.
 */
export async function* sseMessages(
  chunks: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<SSEMessage> {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = (): SSEMessage | null => {
    if (data.length === 0 && !event) return null;
    const message: SSEMessage = { event, data: data.join("\n"), id };
    event = "";
    data = [];
    id = undefined;
    // A frame with a name but no data is legal and carries nothing we want.
    return message.data ? message : null;
  };

  const handleLine = (rawLine: string): SSEMessage | null => {
    // Trailing CR from a `\r\n` stream. Stripping it here rather than
    // normalizing the whole buffer keeps a CR that lands on a chunk boundary
    // from being counted as a line ending of its own.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return dispatch();
    // Keepalive. Servers send these so idle connections survive proxies, and a
    // parser that treats one as data corrupts the next real frame.
    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    return null;
  };

  for await (const chunk of chunks as AsyncIterable<string>) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = handleLine(line);
      if (message) yield message;
      newline = buffer.indexOf("\n");
    }
  }

  // A stream that ends without its final blank line still has one frame in it.
  if (buffer.length > 0) {
    const message = handleLine(buffer);
    if (message) yield message;
  }
  const last = dispatch();
  if (last) yield last;
}

type ParseOptions = {
  /**
   * Set when the agent declared an `output` schema. The same
   * `response.output_text.delta` carries prose in one case and the JSON of the
   * final answer in the other, and only the caller knows which it asked for.
   */
  structuredOutput?: boolean;
};

type PendingCall = { callId: string; name: string; done: boolean };

export async function* parseResponsesStream(
  chunks: AsyncIterable<string> | Iterable<string>,
  options: ParseOptions = {},
): AsyncGenerator<ProviderEvent> {
  // Keyed by `item_id`, because the argument deltas name the item and not the
  // call, and the call id is what the rest of gemi pairs results on.
  const calls = new Map<string, PendingCall>();
  const searchesReported = new Set<string>();
  let finished = false;

  for await (const message of sseMessages(chunks)) {
    if (message.data === "[DONE]") break;

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(message.data);
    } catch {
      // A frame we cannot read is not a reason to abandon a stream that is
      // otherwise fine; the terminal event is what decides how this ended.
      continue;
    }

    // The event name is duplicated in the payload's own `type`. Preferring the
    // payload means a gateway that drops the `event:` line still parses, and
    // the two never disagree in practice.
    const type: string = typeof payload.type === "string" ? payload.type : message.event;

    switch (type) {
      case "response.output_text.delta": {
        const delta = String(payload.delta ?? "");
        if (!delta) break;
        yield options.structuredOutput
          ? { type: "output-delta", delta }
          : { type: "text-delta", delta };
        break;
      }

      // Two names for the same thing across model generations: the summary
      // stream and, on models that expose it, the reasoning text itself.
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = String(payload.delta ?? "");
        if (!delta) break;
        yield { type: "reasoning-delta", delta, id: payload.item_id };
        break;
      }

      case "response.output_item.added": {
        const item = payload.item as Record<string, any> | undefined;
        if (!item) break;
        if (item.type === "function_call") {
          const itemId = String(item.id ?? payload.item_id ?? item.call_id ?? "");
          calls.set(itemId, {
            callId: String(item.call_id ?? itemId),
            name: String(item.name ?? ""),
            done: false,
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const call = calls.get(String(payload.item_id ?? ""));
        if (!call) break;
        const argsDelta = String(payload.delta ?? "");
        if (!argsDelta) break;
        yield {
          type: "tool-call-delta",
          toolCallId: call.callId,
          name: call.name,
          argsDelta,
        };
        break;
      }

      case "response.function_call_arguments.done": {
        const itemId = String(payload.item_id ?? "");
        const call = calls.get(itemId);
        if (!call) break;
        call.done = true;
        yield {
          type: "tool-call",
          toolCallId: call.callId,
          name: call.name,
          args: String(payload.arguments ?? ""),
        };
        break;
      }

      case "response.output_item.done": {
        const item = payload.item as Record<string, any> | undefined;
        if (!item) break;

        if (item.type === "function_call") {
          const itemId = String(item.id ?? payload.item_id ?? item.call_id ?? "");
          const call = calls.get(itemId);
          // Belt and braces: a call whose arguments never got a `done` event
          // still has to reach the agent, or the loop waits for a step that
          // will not arrive.
          if (call?.done) break;
          yield {
            type: "tool-call",
            toolCallId: String(item.call_id ?? itemId),
            name: String(item.name ?? call?.name ?? ""),
            args: String(item.arguments ?? ""),
          };
          if (call) call.done = true;
          break;
        }

        if (item.type === "tool_search_call" || item.type === "tool_search_output") {
          // The call and its output are one thing to a user — "went looking,
          // found these" — so they collapse into one event. Keyed by the call
          // id it belongs to so a pair does not report twice.
          const key = String(item.tool_search_call_id ?? item.id ?? "");
          if (searchesReported.has(key)) break;
          const loaded = loadedToolNames(item);
          if (loaded.length === 0) break;
          searchesReported.add(key);
          yield { type: "tool-search", loaded };
        }
        break;
      }

      // A refusal is the model declining, and it arrives as its own item rather
      // than as an HTTP status. Reporting it as text would put the refusal in
      // the transcript as if it were an answer.
      case "response.refusal.done": {
        yield {
          type: "error",
          error: {
            code: "content_filtered",
            message: String(payload.refusal ?? "The model refused to answer."),
            retryable: false,
          },
        };
        break;
      }

      case "response.completed": {
        finished = true;
        yield { type: "finish", reason: "stop", usage: toUsage(payload.response?.usage) };
        break;
      }

      case "response.incomplete": {
        finished = true;
        const reason = payload.response?.incomplete_details?.reason;
        yield {
          type: "finish",
          reason: reason === "max_output_tokens" ? "length" : "stop",
          usage: toUsage(payload.response?.usage),
        };
        break;
      }

      case "response.failed":
      case "error": {
        finished = true;
        const raw = payload.response?.error ?? payload.error ?? payload;
        yield { type: "error", error: normalizeStreamError(raw) };
        yield { type: "finish", reason: "error", usage: toUsage(payload.response?.usage) };
        break;
      }
    }

    if (finished) return;
  }

  // The connection closed with no terminal event: a dropped socket, a proxy
  // timing out, a process going away mid-answer. Reporting it as a clean stop
  // would tell the agent the model finished talking, and it did not — so this
  // is an error, and a retryable one, because the same request usually works.
  if (!finished) {
    yield {
      type: "error",
      error: {
        code: "provider_error",
        message: "The provider stream ended without a terminal event.",
        retryable: true,
      },
    };
    yield { type: "finish", reason: "error", usage: emptyUsage() };
  }
}

function loadedToolNames(item: Record<string, any>): string[] {
  const raw = item.results ?? item.tools ?? item.loaded ?? item.output;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") names.push(entry);
    else if (entry && typeof entry.name === "string") names.push(entry.name);
    else if (entry && typeof entry.tool_name === "string") names.push(entry.tool_name);
  }
  return names;
}

function normalizeStreamError(raw: any) {
  const message = typeof raw?.message === "string" ? raw.message : "The provider stream failed.";
  const code = String(raw?.code ?? "").toLowerCase();
  if (code === "rate_limit_exceeded") {
    return { code: "rate_limited" as const, message, retryable: true };
  }
  if (code === "context_length_exceeded") {
    return { code: "context_length_exceeded" as const, message, retryable: false };
  }
  if (code.includes("content_filter")) {
    return { code: "content_filtered" as const, message, retryable: false };
  }
  // Mid-stream failures are overwhelmingly transient — the request was accepted,
  // so it was not malformed.
  return { code: "provider_error" as const, message, retryable: true };
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function toUsage(raw: any): Usage {
  if (!raw) return emptyUsage();
  const inputTokens = Number(raw.input_tokens ?? 0);
  const outputTokens = Number(raw.output_tokens ?? 0);
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: Number(raw.total_tokens ?? inputTokens + outputTokens),
  };
  const reasoning = raw.output_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number") usage.reasoningTokens = reasoning;
  const cached = raw.input_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cachedInputTokens = cached;
  return usage;
}

/** A `ReadableStream` of bytes to the string chunks the parser wants. Split out
 *  so the parser never has to know it came from a socket. */
export async function* decodeChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` matters: a multi-byte character can land across two
      // reads, and decoding each read on its own turns it into two U+FFFDs.
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
