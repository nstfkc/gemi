import type {
  ProviderCapabilities,
  ProviderStreamParams,
  ProviderToolNamespace,
  ProviderToolSpec,
} from "../AgentProvider";
import type { JSONSchema } from "../Schema";
import type { AgentMessage, FilePart, ReasoningPart } from "../types";
import { unreadableNote } from "./fileRejection";
import {
  assertFilePart,
  attachmentIdOf,
  attachmentLine,
  isImageFile,
  toolResultOutput,
} from "./request";

/**
 * `ProviderStreamParams` to a Messages API body (`POST /v1/messages`), as a
 * pure function, for the reason `request.ts` gives: everything that can be
 * wrong here is wrong without a socket.
 *
 * The shapes follow Anthropic's API reference. What differs from the
 * Responses builder, and why:
 *
 * - Roles alternate and a tool result is a `user` block. gemi keeps a step's
 *   calls and their results on one assistant message; here the calls stay in
 *   the assistant turn and the results open the user turn right after it.
 * - `max_tokens` is required, so a call without `maxOutputTokens` sends
 *   `DEFAULT_MAX_TOKENS`.
 * - `temperature` is never sent. On API version `2026-10-21` (see
 *   `ANTHROPIC_VERSION`) it is a 400 on every model, whatever its value.
 * - `promptCacheKey` has no Anthropic counterpart: the cache keys on the
 *   prefix itself, so it is not sent. Caching is asked for with `cache_control`
 *   breakpoints instead; see `withCacheBreakpoints`.
 */

export type MessagesBlock = Record<string, unknown>;
export type MessagesMessage = { role: "user" | "assistant"; content: MessagesBlock[] };
export type MessagesTool = Record<string, unknown>;

export type MessagesRequest = {
  model: string;
  max_tokens: number;
  messages: MessagesMessage[];
  stream: true;
  system?: MessagesBlock[];
  tools?: MessagesTool[];
  tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config?: {
    effort?: string;
    format?: { type: "json_schema"; schema: JSONSchema };
  };
};

/**
 * Sent when the agent sets no `maxOutputTokens`. Every current Claude model
 * takes 64K or more (128K on the 4.6-and-later families, 64K on Haiku 4.5), and
 * the request is streamed, so a high cap costs nothing until it is used; a low
 * one cuts an answer off mid-thought.
 */
export const DEFAULT_MAX_TOKENS = 64_000;

export function buildMessagesRequest(
  params: ProviderStreamParams,
  ctx: { model: string; capabilities: ProviderCapabilities; forcedToolChoice: boolean },
): MessagesRequest {
  const body: MessagesRequest = {
    model: ctx.model,
    max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: toMessages(params.messages, ctx.capabilities),
    stream: true,
  };

  const system = [params.systemPrompt, looseOutputInstruction(params.output)].filter(Boolean);
  if (system.length > 0) body.system = [{ type: "text", text: system.join("\n\n") }];

  // Adaptive thinking with the agent's effort. `"none"` keeps thinking off but
  // still sends an effort, because the newest models cannot turn thinking
  // off (`disabled` is a 400) and a low effort is the nearest thing.
  const reasoning = ctx.capabilities.reasoning ? params.reasoning : undefined;
  if (reasoning) {
    if (reasoning !== "none") body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: effortOf(reasoning) };
  }

  if (params.output?.strict) {
    body.output_config = {
      ...body.output_config,
      format: { type: "json_schema", schema: toClaudeSchema(params.output.schema) },
    };
  }

  const tools = toMessagesTools(params.tools);
  if (tools.length > 0) {
    body.tools = tools;
    // With thinking on, only `auto` and `none` are accepted on any model.
    const choice = toolChoice(params.toolChoice, ctx.forcedToolChoice && !body.thinking);
    if (!ctx.capabilities.parallelToolCalls) choice.disable_parallel_tool_use = true;
    if (params.toolChoice !== undefined || choice.disable_parallel_tool_use) body.tool_choice = choice;
  }

  return withCacheBreakpoints(body);
}

/**
 * gemi's effort onto `output_config.effort` (`low` … `max`). `minimal` and
 * `none` have no counterpart and are `low`; anything else is sent as written,
 * so a new level works without a gemi release.
 */
function effortOf(reasoning: string): string {
  return reasoning === "none" || reasoning === "minimal" ? "low" : reasoning;
}

/**
 * Prompt caching. The cache holds a prefix in render order (`tools`, then
 * `system`, then `messages`) up to a block marked `cache_control`, so three
 * breakpoints cover what an agent repeats: the last tool (the tool list), the
 * system prompt, and the last block of the last message, which the next step
 * extends, so it reads this step's prefix back. That is three of the four
 * allowed. A prefix under the model's minimum (512 tokens on the 5.x models)
 * is not cached and costs nothing extra; a cache write costs 1.25x input.
 *
 * Thinking blocks cannot carry `cache_control`, so the last message's
 * breakpoint goes on its last block that can.
 */
function withCacheBreakpoints(body: MessagesRequest): MessagesRequest {
  const mark = (block: MessagesBlock | MessagesTool | undefined) => {
    if (block) block.cache_control = { type: "ephemeral" };
  };
  mark(body.tools?.at(-1));
  mark(body.system?.at(-1));
  const last = body.messages.at(-1)?.content ?? [];
  mark([...last].reverse().find((b) => b.type !== "thinking" && b.type !== "redacted_thinking"));
  return body;
}

// --- structured output ---------------------------------------------------

/**
 * Keywords structured outputs refuse, per Anthropic's JSON schema limits:
 * numeric and string length constraints, and array constraints beyond
 * `minItems` 0 or 1. They are removed from what is sent, as the SDKs do, and
 * still hold: `Agent` validates the answer against the agent's own schema.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
]);

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

export function toClaudeSchema(schema: JSONSchema): JSONSchema {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.has(key)) continue;
      if (key === "minItems" && typeof value === "number" && value > 1) continue;
      // These map names to schemas; a property named `minimum` is kept.
      out[key] = SCHEMA_MAPS.has(key) && isObject(value)
        ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, strip(sub)]))
        : strip(value);
    }
    return out;
  };
  return strip(schema) as JSONSchema;
}

/**
 * A schema that is not `strict` holds a free-form node (`s.json()`), which
 * structured outputs cannot express (every object needs `additionalProperties:
 * false`). It is not sent as `output_config.format`, which would be a 400;
 * the model is asked for the JSON in the system prompt instead, and `Agent`
 * validates what comes back.
 */
function looseOutputInstruction(output: ProviderStreamParams["output"]): string | undefined {
  if (!output || output.strict) return undefined;
  return `Answer with only a JSON value (no prose, no code fence) that matches this JSON schema:\n${JSON.stringify(output.schema)}`;
}

/**
 * gemi's `toolChoice` onto `tool_choice`.
 *
 * `"required"` is `any` and `{ name }` is `tool`, on the models that take them.
 * Claude Opus 5.5, Claude Sonnet 5.5 and Claude Fable 5.1 answer both with a
 * 400 (`tool_choice: type "tool" and "any" are not supported for this model.`),
 * so on those, and on any id `supportsForcedToolChoice` does not know, the
 * choice is sent as `auto`: the step still runs, and the prompt that asked for
 * the tool still asks for it. Failing the step instead would fail every step a
 * `prepareStep` forces, with no setting to turn it off.
 */
function toolChoice(
  choice: ProviderStreamParams["toolChoice"],
  forced: boolean,
): NonNullable<MessagesRequest["tool_choice"]> {
  if (choice === "none") return { type: "none" };
  if (choice === "required") return forced ? { type: "any" } : { type: "auto" };
  if (choice && typeof choice === "object") {
    return forced ? { type: "tool", name: choice.name } : { type: "auto" };
  }
  return { type: "auto" };
}

// --- messages ------------------------------------------------------------

/**
 * `AgentMessage[]` to alternating `user` / `assistant` messages.
 *
 * Parts are laid out in order, each with the role it has on this API: the
 * assistant's text and tool calls are `assistant`, a tool result is `user`, and
 * the user's own words and files are `user`. Consecutive blocks of one role
 * are one message, which is what the API wants and what a step that called
 * three tools needs: three `tool_use` blocks in one turn, three `tool_result`
 * blocks in the next.
 *
 * Tool results are not placed where they sit in gemi's message but right after
 * the turn that made their calls, first in the user turn, in call order: the
 * API requires every `tool_use` to be answered in the very next message, with
 * the results before anything else in it. A step's calls are answered where
 * the step is known to be over: at the next message, or, when gemi kept the
 * next step on the same message, at the first block after a tool result. The
 * pairing rules are those of
 * `reconcileToolPairs` in `request.ts`, and for the same reasons: a repeated
 * call or result is dropped, a result for a call this history does not hold is
 * dropped, and a call left without a result gets one saying so.
 */
export function toMessages(
  messages: AgentMessage[],
  capabilities: ProviderCapabilities,
): MessagesMessage[] {
  // `step-end` marks where a step's calls are known to be done: a new
  // message, or a tool result (the next step's blocks can share the message).
  const blocks: ({ role: "user" | "assistant"; block: MessagesBlock } | "step-end")[] = [];
  const results = new Map<string, MessagesBlock>();

  for (const message of messages) {
    // A system-role message in the history is the app's, not the user's, but
    // `messages` takes only two roles; it is sent as user text.
    const role = message.role === "assistant" ? "assistant" : "user";
    blocks.push("step-end");
    for (const part of message.content ?? []) {
      switch (part.type) {
        case "text": {
          // The assistant's text goes back exactly as the model wrote it,
          // whitespace-only blocks included (the "\n\n" before a tool call):
          // anything else is an edit to the turn. Only an empty string, which
          // the API refuses, is left out. A user's blank text is noise.
          const keep = role === "assistant" ? !!part.text : !!part.text?.trim();
          if (keep) blocks.push({ role, block: { type: "text", text: part.text } });
          break;
        }
        case "output": {
          if (part.partial) break;
          // The model's own text when the part kept it; re-serializing the
          // value would change its whitespace and number formatting.
          const text = part.text ?? JSON.stringify(part.value);
          blocks.push({ role, block: { type: "text", text } });
          break;
        }
        case "file": {
          if (role === "assistant") break;
          for (const block of fileBlocks(part, capabilities)) blocks.push({ role, block });
          break;
        }
        case "reasoning": {
          // Claude's own thinking goes back as it came, signature and all,
          // empty ones included. Another provider's reasoning (a Responses
          // item id) means nothing here and is left out.
          const block = role === "assistant" ? thinkingBlock(part) : undefined;
          if (block) blocks.push({ role, block });
          break;
        }
        case "tool-call": {
          if (part.partial) break;
          blocks.push({
            role: "assistant",
            block: {
              type: "tool_use",
              id: part.toolCallId,
              name: String(part.name),
              input: isObject(part.input) ? part.input : {},
            },
          });
          break;
        }
        case "tool-result": {
          blocks.push("step-end");
          if (results.has(part.toolCallId)) break;
          results.set(part.toolCallId, {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            content: toolResultOutput(part),
            ...(part.status === "error" ? { is_error: true } : {}),
          });
          break;
        }
      }
    }
  }

  const out: MessagesMessage[] = [];
  const push = (role: "user" | "assistant", block: MessagesBlock) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  const called = new Set<string>();
  // The calls of the assistant turn being written, answered when it ends.
  let open: string[] = [];
  let stepEnded = false;
  const answer = () => {
    for (const id of open) push("user", results.get(id) ?? noResult(id));
    open = [];
    stepEnded = false;
  };

  for (const entry of blocks) {
    if (entry === "step-end") {
      stepEnded = true;
      continue;
    }
    const { role, block } = entry;
    // Anything after a finished step's calls, in either role, comes after
    // their results.
    if (stepEnded || role === "user") answer();
    if (block.type === "tool_use") {
      const id = String(block.id);
      if (called.has(id)) continue;
      called.add(id);
      open.push(id);
    }
    push(role, block);
  }
  answer();

  // The API wants a user turn first, and on the 4.6-and-later models it
  // refuses a history that ends on the assistant (that is a prefill). Both
  // happen when an app starts a run from a trimmed or assistant-authored
  // history. The turns added are fixed text, so the prefix stays the same
  // from one step to the next.
  if (out[0]?.role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: HISTORY_STARTS_HERE }] });
  }
  if (out.at(-1)?.role === "assistant") {
    out.push({ role: "user", content: [{ type: "text", text: CONTINUE }] });
  }
  return out;
}

const HISTORY_STARTS_HERE = "(The conversation continues from an earlier point.)";
const CONTINUE = "Continue.";

const NO_RESULT_RECORDED = "No result was recorded for this tool call. Assume it did not complete.";

function noResult(toolUseId: string): MessagesBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content: NO_RESULT_RECORDED };
}

/** A reasoning part this provider wrote, back as its block; else nothing. */
function thinkingBlock(part: ReasoningPart): MessagesBlock | undefined {
  const meta = part.providerMetadata?.anthropic;
  if (!isObject(meta)) return undefined;
  if (meta.type === "thinking" && typeof meta.signature === "string") {
    return { type: "thinking", thinking: part.text ?? "", signature: meta.signature };
  }
  if (meta.type === "redacted_thinking" && typeof meta.data === "string") {
    return { type: "redacted_thinking", data: meta.data };
  }
  return undefined;
}

/**
 * A file part as the model is told about it, with the rules of the `file` case
 * in `toResponsesInput`: the attachment line when the part has an attachment
 * id, and the file itself when the model can read it.
 *
 * Files go by Files API id (`source: {type: "file"}`): an image as an `image`
 * block, a PDF or plain text as a `document`. Those are the types the API
 * reads; any other file is not shown (it would be a 400), and the model is told
 * so. Without `fileInput` it is the attachment line alone.
 */
function fileBlocks(part: FilePart, capabilities: ProviderCapabilities): MessagesBlock[] {
  const attachmentId = attachmentIdOf(part);
  const line = (shown: boolean): MessagesBlock[] =>
    attachmentId ? [{ type: "text", text: attachmentLine(part, shown) }] : [];
  if (!capabilities.fileInput) return line(false);
  assertFilePart(part, attachmentId);
  if (!part.fileId) return line(false);
  const kind = part.providerRejected ? undefined : fileKind(part);
  if (!kind) return [...line(false), { type: "text", text: unreadableNote(part.name) }];
  return [...line(true), { type: kind, source: { type: "file", file_id: part.fileId } }];
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function fileKind(part: FilePart): "image" | "document" | undefined {
  const mimeType = part.mimeType?.trim().toLowerCase() ?? "";
  if (isImageFile(part)) return !mimeType || IMAGE_TYPES.has(mimeType) ? "image" : undefined;
  if (mimeType) return mimeType === "application/pdf" || mimeType === "text/plain" ? "document" : undefined;
  return /\.(pdf|txt)$/i.test(part.name ?? "") ? "document" : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// --- tools ---------------------------------------------------------------

function isNamespace(
  entry: ProviderToolSpec | ProviderToolNamespace,
): entry is ProviderToolNamespace {
  return Array.isArray((entry as ProviderToolNamespace).tools);
}

/**
 * Tools onto the `tools` array, flat: this provider reports no tool search
 * (`capabilitiesForClaude`), so a namespace is flattened and a deferred tool
 * is sent whole, exactly as `toResponsesTools` does for a model without it.
 *
 * `strict` is not sent. Anthropic's strict tool use allows at most 20 strict
 * tools and 24 optional parameters across them per request, and refuses
 * numeric and length constraints, so passing gemi's flag through would turn an
 * agent with many tools into a 400. `Agent` validates every call's arguments
 * against the tool's schema either way.
 *
 * `eager_input_streaming` is on for every tool: the request is always
 * streamed, and without it the API buffers each argument until it is whole, so
 * a tool that writes a file sends nothing for as long as the model writes it.
 * It also gives up the API's own validation of the arguments, which `Agent`
 * does anyway.
 */
export function toMessagesTools(
  tools: (ProviderToolSpec | ProviderToolNamespace)[] | undefined,
): MessagesTool[] {
  const out: MessagesTool[] = [];
  for (const entry of tools ?? []) {
    for (const tool of isNamespace(entry) ? entry.tools : [entry]) {
      out.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        eager_input_streaming: true,
      });
    }
  }
  return out;
}
