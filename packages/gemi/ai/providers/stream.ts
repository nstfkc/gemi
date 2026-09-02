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

type PendingCall = { callId: string; name: string; namespace?: string; done: boolean };

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
            // FLAT, and pinned by a test against the recorded stream. A call to
            // a function inside a namespace comes back as
            // `{name:"getOrder", namespace:"crm"}` — not `"crm.getOrder"` — so
            // the name is already the registry key `Agent` looks tools up by,
            // and qualifying it here would break every lookup. The namespace is
            // carried alongside rather than folded in, because a name that is
            // sometimes qualified is a name nothing can match on.
            name: String(item.name ?? ""),
            namespace: typeof item.namespace === "string" && item.namespace
              ? item.namespace
              : undefined,
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
          // Spread rather than `namespace: call.namespace`: a flat tool has no
          // namespace, and an explicit `undefined` is a key a consumer has to
          // remember to check for.
          ...(call.namespace ? { namespace: call.namespace } : {}),
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
          ...(call.namespace ? { namespace: call.namespace } : {}),
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
          const namespace =
            (typeof item.namespace === "string" ? item.namespace : "") || call?.namespace;
          yield {
            type: "tool-call",
            toolCallId: String(item.call_id ?? itemId),
            name: String(item.name ?? call?.name ?? ""),
            args: String(item.arguments ?? ""),
            ...(namespace ? { namespace } : {}),
          };
          if (call) call.done = true;
          break;
        }

        if (item.type === "tool_search_call" || item.type === "tool_search_output") {
          // The call and its output are one thing to a user — "went looking,
          // found these" — so they collapse into one event. Two mechanisms do
          // that, and which one fires depends on what the server sent:
          //
          // 1. THE PAIR IS LINKED. The documented shape puts
          //    `tool_search_call_id` on the output item, naming the call item's
          //    id, so both sides key the same and the second one is dropped.
          //
          // 2. THE PAIR IS NOT LINKED, which is what the live API actually
          //    sends. In `__fixtures__/openai-tool-search.sse` the call is
          //    `tsc_08945…`, the output is `tso_08945…`, `call_id` is null on
          //    both and neither carries `tool_search_call_id` — so there is
          //    nothing to pair them on. What collapses them there is the
          //    `found` check below: only the OUTPUT item carries a `tools`
          //    array, and the call item carries the query it ran
          //    (`arguments.paths`), which is not a result and is not reported
          //    as one.
          //
          // That second one used to be load-bearing and unwritten — the dedup
          // key was doing nothing and the length check was doing all the work
          // by accident. Both are tested now: "the tool_search call and its
          // output collapse into one event" in `stream.test.ts` covers (1), and
          // "nothing in the recording links the search call to its output"
          // plus "reports one event from the real stream, despite that" in
          // `recordings.test.ts` cover (2).
          const found = toolSearchReport(item);
          if (found.loaded.length === 0 && found.namespaces.length === 0) break;
          const key = String(item.tool_search_call_id ?? item.id ?? "");
          if (searchesReported.has(key)) break;
          searchesReported.add(key);
          yield { type: "tool-search", ...found };
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

      /**
       * Two very different endings share this frame, and the old code called
       * both of them "stop".
       *
       * `max_output_tokens` is a truncated answer. `content_filter` is Azure
       * blocking the request — verified against
       * `__fixtures__/azure-content-filtered.sse`, where a prompt that trips
       * the filter answers HTTP 200, streams a polite refusal, and ends
       * `response.incomplete` with `incomplete_details.reason` of
       * `content_filter`. Reporting that as a clean stop tells the agent the
       * model finished talking, which is exactly the mistake `content_filtered`
       * exists to prevent: the run reads as a normal answer, the loop takes
       * another step, and nothing anywhere says the content was blocked.
       *
       * The detail comes off Azure's `content_filters` array rather than off
       * the frame, because `incomplete_details` carries the word
       * `content_filter` and nothing else — no category, no severity.
       */
      case "response.incomplete": {
        finished = true;
        const usage = toUsage(payload.response?.usage);
        const reason = payload.response?.incomplete_details?.reason;
        if (reason === "content_filter") {
          yield {
            type: "error",
            error: {
              code: "content_filtered",
              message: describeContentFilters(payload.response?.content_filters),
              retryable: false,
            },
          };
          yield { type: "finish", reason: "error", usage };
          break;
        }
        yield {
          type: "finish",
          reason: reason === "max_output_tokens" ? "length" : "stop",
          usage,
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

/**
 * What a tool search actually pulled in.
 *
 * The entries of `tool_search_output.tools` are NAMESPACES, not functions:
 *
 *   [{type:"namespace", name:"crm", tools:[{type:"function", name:"listOrders"},
 *                                          {type:"function", name:"getOrder"}]}]
 *
 * — verified against `__fixtures__/openai-tool-search.sse`. Reading `name` off
 * the top level, which is what this did, reported `loaded: ["crm"]` for a
 * search that loaded `listOrders` and `getOrder`. The names it reported were
 * not names of tools, and nothing downstream could tell, because a namespace
 * name is a plausible tool name.
 *
 * BOTH HALVES ARE REPORTED. "Searched crm, loaded getOrder" is the sentence a
 * UI wants, and neither field can be recovered from the other: flattening to
 * `crm.getOrder` would invent a name the model never used (calls come back with
 * a flat `name` — see the `function_call` branch above), and dropping the
 * namespace throws away the only description of the *group*, which is the thing
 * the model actually chose between.
 *
 * The shape is read structurally rather than off `type === "namespace"`: an
 * entry with a `tools` array is a group whatever it calls itself, and the
 * hand-written fixtures that predate the recording use `results:[{name}]` with
 * no `type` at all.
 */
type ToolSearchReport = { loaded: string[]; namespaces: string[] };

function toolSearchReport(item: Record<string, any>): ToolSearchReport {
  const loaded: string[] = [];
  const namespaces: string[] = [];
  collectToolNames(item.results ?? item.tools ?? item.loaded ?? item.output, loaded, namespaces, 0);
  return { loaded: unique(loaded), namespaces: unique(namespaces) };
}

function collectToolNames(
  raw: unknown,
  loaded: string[],
  namespaces: string[],
  depth: number,
): void {
  // Nesting is one level deep today and a namespace of namespaces is not a
  // thing. The cap is here so a payload that disagrees costs a truncated event
  // rather than a blown stack in the middle of someone's stream.
  if (!Array.isArray(raw) || depth > 4) return;
  for (const entry of raw) {
    if (typeof entry === "string") {
      loaded.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, any>;
    const name =
      typeof e.name === "string" ? e.name : typeof e.tool_name === "string" ? e.tool_name : "";
    const children = e.tools ?? e.functions;
    if (Array.isArray(children)) {
      if (name) namespaces.push(name);
      collectToolNames(children, loaded, namespaces, depth + 1);
      continue;
    }
    if (name) loaded.push(name);
  }
}

function unique(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) === index);
}

/**
 * Azure's `content_filters`, read only where it means something.
 *
 * IT DOES NOT MAP ONTO `content_filtered` ON ITS OWN, and that is the decision
 * worth writing down: the array is on EVERY Azure response — `azure-text.sse`,
 * a recording of "say hi", carries it on `response.created`,
 * `response.in_progress` and `response.completed`, with `blocked:false` and
 * every category `severity:"safe"`. Treating its presence as a filter hit would
 * report every single Azure call as content-filtered, and treating any
 * `filtered:true` inside it as one would report a *warning* as a block. What is
 * authoritative about the outcome is `incomplete_details.reason`; this array is
 * authoritative only about the DETAIL, which is why it is read for a message
 * and for nothing else.
 *
 * OpenAI sends no such array. It signals a block by refusing in-band
 * (`response.refusal.done`, handled above) or by rejecting the request, so
 * nothing here needs a provider flag — an absent array just yields the generic
 * sentence.
 */
function describeContentFilters(raw: unknown): string {
  const generic = "The provider's content filter blocked this request.";
  if (!Array.isArray(raw)) return generic;
  const hits: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, any>;
    const results = e.content_filter_results;
    if (!results || typeof results !== "object") continue;
    for (const [category, detail] of Object.entries(results as Record<string, any>)) {
      if (detail && typeof detail === "object" && detail.filtered === true) {
        // The source matters as much as the category: a `prompt` hit means the
        // user's own words were blocked and rewording works, a `completion` hit
        // means the model's answer was, and retrying the same prompt will not.
        hits.push(`${category} (${String(e.source_type ?? "unknown")})`);
      }
    }
  }
  return hits.length === 0 ? generic : `${generic} Categories: ${unique(hits).join(", ")}.`;
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
