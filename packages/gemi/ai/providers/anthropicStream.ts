import type { ProviderEvent } from "../AgentProvider";
import type { AgentError, FinishReason, Usage } from "../types";
import { emptyUsage, sseMessages } from "./stream";

/**
 * The Messages API SSE stream to `ProviderEvent`, a pure function over chunks
 * like `parseResponsesStream`, driven in the tests by the hand-written
 * fixtures in `__fixtures__/anthropic-*.sse`.
 *
 * The event flow, from Anthropic's streaming reference: `message_start` (the
 * model and the input usage), then per content block `content_block_start`,
 * its `content_block_delta`s and `content_block_stop`, then `message_delta`
 * (the stop reason, and usage that is CUMULATIVE, not an increment) and
 * `message_stop`. `ping` frames come at any time, an `error` frame can replace
 * the rest, and unknown event types are to be ignored.
 *
 * Thinking is `reasoning-delta`s with no id. A `thinking` block's text streams
 * as it comes, and at its stop one more, empty delta carries the signature as
 * `providerMetadata.anthropic`, which closes the part. A `redacted_thinking`
 * block is one empty delta carrying its `data`. `anthropicRequest.ts` turns
 * those parts back into the blocks, unchanged, as the API requires.
 */

type ParseOptions = {
  /** The agent asked for an `output` schema, so text is the answer's JSON. */
  structuredOutput?: boolean;
};

type OpenBlock = { type: string; id?: string; name?: string; args: string; signature: string };

export async function* parseMessagesStream(
  chunks: AsyncIterable<string> | Iterable<string>,
  options: ParseOptions = {},
): AsyncGenerator<ProviderEvent> {
  const blocks = new Map<number, OpenBlock>();
  // Calls whose arguments are not whole JSON, held until the stop reason says
  // whether they were cut off.
  const held: OpenBlock[] = [];
  let model: string | undefined;
  let usage: RawUsage = {};
  let stopReason: string | undefined;
  let stopDetails: Record<string, any> | undefined;
  let finished = false;

  const ended = (reason: FinishReason): ProviderEvent => ({
    type: "finish",
    reason,
    usage: toAnthropicUsage(usage),
    ...(model ? { model } : {}),
  });

  for await (const message of sseMessages(chunks)) {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(message.data);
    } catch {
      continue;
    }
    const type: string = typeof payload.type === "string" ? payload.type : message.event;

    switch (type) {
      case "message_start": {
        const start = payload.message ?? {};
        if (typeof start.model === "string" && start.model) model = start.model;
        usage = mergeUsage(usage, start.usage);
        break;
      }

      case "content_block_start": {
        const index = Number(payload.index);
        const block = payload.content_block ?? {};
        const open: OpenBlock = {
          type: String(block.type ?? ""),
          id: typeof block.id === "string" ? block.id : undefined,
          name: typeof block.name === "string" ? block.name : undefined,
          args: "",
          signature: typeof block.signature === "string" ? block.signature : "",
        };
        blocks.set(index, open);
        // Redacted thinking arrives whole: encrypted, nothing to show, and
        // sent back as it came.
        if (open.type === "redacted_thinking") {
          yield {
            type: "reasoning-delta",
            delta: "",
            providerMetadata: { anthropic: { type: "redacted_thinking", data: String(block.data ?? "") } },
          };
        }
        // A text block opens empty in every recorded shape, but the field is
        // there, so a gateway that sends it whole is read.
        if (open.type === "text" && typeof block.text === "string" && block.text) {
          yield textEvent(block.text, options);
        }
        break;
      }

      case "content_block_delta": {
        const block = blocks.get(Number(payload.index));
        const delta = payload.delta ?? {};
        if (!block) break;
        if (delta.type === "text_delta") {
          const text = String(delta.text ?? "");
          if (text) yield textEvent(text, options);
        } else if (delta.type === "thinking_delta") {
          const text = String(delta.thinking ?? "");
          if (text) yield { type: "reasoning-delta", delta: text };
        } else if (delta.type === "signature_delta") {
          block.signature += String(delta.signature ?? "");
        } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
          const fragment = String(delta.partial_json ?? "");
          if (!fragment) break;
          block.args += fragment;
          yield {
            type: "tool-call-delta",
            toolCallId: block.id ?? "",
            name: block.name ?? "",
            argsDelta: fragment,
          };
        }
        break;
      }

      case "content_block_stop": {
        const index = Number(payload.index);
        const block = blocks.get(index);
        blocks.delete(index);
        // The signature closes the thinking part, and is what lets it be sent
        // back (see `ReasoningPart.providerMetadata`). A block with no text
        // (`display: "omitted"`) still becomes a part: it has to go back too.
        if (block?.type === "thinking") {
          yield {
            type: "reasoning-delta",
            delta: "",
            providerMetadata: { anthropic: { type: "thinking", signature: block.signature } },
          };
        }
        if (block?.type === "tool_use") {
          // A call with no arguments streams no delta at all; its input is
          // the empty object.
          block.args ||= "{}";
          // A block is stopped even when `max_tokens` cut it off, and then its
          // arguments are a prefix of the JSON. Such a call must not be
          // emitted whole, or it would run; it is held for `message_stop`.
          if (isJson(block.args)) yield toolCall(block);
          else held.push(block);
        }
        break;
      }

      case "message_delta": {
        if (typeof payload.delta?.stop_reason === "string") stopReason = payload.delta.stop_reason;
        if (payload.delta?.stop_details) stopDetails = payload.delta.stop_details;
        usage = mergeUsage(usage, payload.usage);
        break;
      }

      case "message_stop": {
        finished = true;
        // A refusal is the model's safety classifier declining, on HTTP 200.
        // Ending it `stop` would read as an answer, which is the mistake
        // `content_filtered` exists to prevent (as with OpenAI's refusal item).
        if (stopReason === "refusal") {
          yield { type: "error", error: refusalError(stopDetails) };
          yield ended("error");
          break;
        }
        const reason = finishReasonOf(stopReason);
        // Cut off: the held calls never finished, so they are discarded (the
        // agent forgets them and the client removes their partial parts) and
        // the call ends `length`. Otherwise a held call is the model's own
        // malformed JSON, passed on for `Agent` to report against the tool.
        if (held.length > 0 && reason === "length") {
          yield { type: "tool-call-discard", toolCallIds: held.map((b) => b.id ?? "") };
        } else {
          for (const block of held) yield toolCall(block);
        }
        yield ended(reason);
        break;
      }

      case "error": {
        finished = true;
        yield { type: "error", error: anthropicStreamError(payload.error ?? payload) };
        yield ended("error");
        break;
      }
    }

    if (finished) return;
  }

  // No `message_stop`: the connection closed under the answer. Retryable, as
  // in `parseResponsesStream`.
  yield {
    type: "error",
    error: {
      code: "provider_error",
      message: "The provider stream ended without a terminal event.",
      retryable: true,
    },
  };
  yield ended("error");
}

function toolCall(block: OpenBlock): ProviderEvent {
  return { type: "tool-call", toolCallId: block.id ?? "", name: block.name ?? "", args: block.args };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function textEvent(delta: string, options: ParseOptions): ProviderEvent {
  return options.structuredOutput ? { type: "output-delta", delta } : { type: "text-delta", delta };
}

/**
 * `stop_reason` onto gemi's finish reasons. `max_tokens` is a truncated answer,
 * and so is `model_context_window_exceeded` (the answer ran into the context
 * window rather than the cap). Everything else that ends a turn normally
 * (`end_turn`, `tool_use`, `stop_sequence`, and `pause_turn`, which only
 * server tools produce) is `stop`; `Agent` reads the tool calls themselves.
 */
function finishReasonOf(stopReason: string | undefined): FinishReason {
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") return "length";
  return "stop";
}

function refusalError(details: Record<string, any> | undefined): AgentError {
  const explanation = typeof details?.explanation === "string" ? details.explanation : "";
  const category = typeof details?.category === "string" ? ` (${details.category})` : "";
  return {
    code: "content_filtered",
    message: explanation || `The model declined to answer${category}.`,
    retryable: false,
  };
}

/**
 * An `error` frame, which arrives on a 200: the request was accepted and the
 * failure came later, so it is retryable unless its type says the request
 * itself is wrong. `overloaded_error` is the one seen most, the 529 of a
 * streamed call.
 */
export function anthropicStreamError(raw: any): AgentError {
  const type = String(raw?.type ?? "").toLowerCase();
  const message = typeof raw?.message === "string" ? raw.message : "The provider stream failed.";
  if (type === "rate_limit_error") return { code: "rate_limited", message, retryable: true };
  if (type === "invalid_request_error" || type === "request_too_large") {
    const tooLong = /prompt is too long|request_too_large/i.test(`${type} ${message}`);
    return {
      code: tooLong ? "context_length_exceeded" : "provider_error",
      message,
      retryable: false,
    };
  }
  if (
    type === "authentication_error" ||
    type === "permission_error" ||
    type === "billing_error" ||
    type === "not_found_error"
  ) {
    return { code: "provider_error", message, retryable: false };
  }
  return { code: "provider_error", message, retryable: true };
}

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** From `output_tokens_details.thinking_tokens`, part of `output_tokens`. */
  thinking_tokens?: number;
};

/** The latest value of each field: `message_delta` usage is cumulative. */
function mergeUsage(total: RawUsage, raw: any): RawUsage {
  if (!raw || typeof raw !== "object") return total;
  const next = { ...total };
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const) {
    if (typeof raw[key] === "number") next[key] = raw[key];
  }
  const thinking = raw.output_tokens_details?.thinking_tokens;
  if (typeof thinking === "number") next.thinking_tokens = thinking;
  return next;
}

/**
 * Anthropic usage onto `Usage`.
 *
 * Anthropic reports input in three disjoint parts: `input_tokens` (after the
 * last cache breakpoint), `cache_read_input_tokens` and
 * `cache_creation_input_tokens`. gemi's `inputTokens` is the whole prompt, as
 * OpenAI reports it, so it is their sum, and the two cache parts are its
 * breakdown (`cachedInputTokens`, `cacheWriteInputTokens`). Thinking tokens are part
 * of `output_tokens` and are its `reasoningTokens` breakdown. A field the
 * response did not carry stays absent rather than zero.
 */
export function toAnthropicUsage(raw: RawUsage | undefined): Usage {
  if (!raw) return emptyUsage();
  const read = raw.cache_read_input_tokens;
  const write = raw.cache_creation_input_tokens;
  const inputTokens = (raw.input_tokens ?? 0) + (read ?? 0) + (write ?? 0);
  const outputTokens = raw.output_tokens ?? 0;
  const usage: Usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  if (typeof read === "number") usage.cachedInputTokens = read;
  if (typeof write === "number") usage.cacheWriteInputTokens = write;
  if (typeof raw.thinking_tokens === "number") usage.reasoningTokens = raw.thinking_tokens;
  return usage;
}
