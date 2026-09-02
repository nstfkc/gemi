import type {
  ProviderCapabilities,
  ProviderStreamParams,
  ProviderToolNamespace,
  ProviderToolSpec,
} from "../AgentProvider";
import type { AgentMessage, ToolResultPart } from "../types";

/**
 * Building the request body is a pure function, on purpose.
 *
 * Everything hard about this provider is in here — item ordering, tool-call
 * pairing, what a denied call looks like on the wire — and none of it needs a
 * socket to be wrong. So it is separated from the class that posts it, and the
 * tests assert the object rather than mocking `fetch` and reading a string.
 */

// The wire shapes, typed loosely on purpose: these mirror OpenAI's schema, and
// a precise mirror is a second thing to keep in sync for no checking we would
// actually get — the API is the authority and it answers in HTTP.
export type ResponsesInputItem = Record<string, unknown>;
export type ResponsesTool = Record<string, unknown>;

export type ResponsesRequest = {
  model: string;
  input: ResponsesInputItem[];
  stream: true;
  instructions?: string;
  tools?: ResponsesTool[];
  parallel_tool_calls?: boolean;
  text?: { format: Record<string, unknown> };
  reasoning?: { effort: string; summary: "auto" };
  temperature?: number;
  max_output_tokens?: number;
};

export function buildResponsesRequest(
  params: ProviderStreamParams,
  ctx: { model: string; capabilities: ProviderCapabilities },
): ResponsesRequest {
  const { capabilities } = ctx;

  const body: ResponsesRequest = {
    model: ctx.model,
    input: toResponsesInput(params.messages, capabilities),
    stream: true,
  };

  if (params.systemPrompt) body.instructions = params.systemPrompt;

  const tools = toResponsesTools(params.tools, capabilities);
  if (tools.length > 0) {
    body.tools = tools;
    if (!capabilities.parallelToolCalls) body.parallel_tool_calls = false;
  }

  if (params.output && capabilities.structuredOutput) {
    body.text = {
      format: {
        type: "json_schema",
        name: params.output.name,
        schema: params.output.schema,
        strict: true,
      },
    };
  }

  // Dropped rather than refused: a model that cannot reason should still answer
  // an agent that asked it to, because `reasoning` is the agent's preference
  // and the provider is where preferences meet reality.
  if (params.reasoning && capabilities.reasoning) {
    // `summary: "auto"` is not decoration — without it the stream carries no
    // reasoning text at all, and `ReasoningPart` would have nothing to hold.
    body.reasoning = { effort: params.reasoning, summary: "auto" };
  }

  if (typeof params.temperature === "number") body.temperature = params.temperature;
  if (typeof params.maxOutputTokens === "number") body.max_output_tokens = params.maxOutputTokens;

  return body;
}

// --- messages ------------------------------------------------------------

/**
 * `AgentMessage[]` to Responses input items.
 *
 * Order is preserved *within* a message, not just between messages: a message
 * that holds reasoning, then a tool call, then its result has to arrive in that
 * order, because the API validates the pairing positionally. So text and file
 * parts are buffered into one message item and that buffer is flushed the
 * moment a non-message item appears, rather than emitting all the text first
 * and all the calls after.
 */
export function toResponsesInput(
  messages: AgentMessage[],
  capabilities: ProviderCapabilities,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];

  for (const message of messages) {
    const role = message.role;
    let buffer: Record<string, unknown>[] = [];

    const flush = () => {
      if (buffer.length === 0) return;
      items.push({ type: "message", role, content: buffer });
      buffer = [];
    };

    for (const part of message.content ?? []) {
      switch (part.type) {
        case "text": {
          if (!part.text) break;
          buffer.push(textContent(role, part.text));
          break;
        }
        case "output": {
          // A structured answer is still the assistant's text as far as the
          // history is concerned; re-serializing it is what lets a follow-up
          // turn refer to what was decided.
          if (part.partial) break;
          buffer.push(textContent(role, JSON.stringify(part.value)));
          break;
        }
        case "file": {
          // `input_file` is only legal on an input role. An assistant message
          // holding a file is a bug upstream, and sending it anyway turns that
          // bug into a 400 halfway through a conversation.
          if (!capabilities.fileInput || role === "assistant") break;
          buffer.push({ type: "input_file", file_id: part.fileId });
          break;
        }
        case "reasoning": {
          flush();
          const item = reasoningItem(part);
          if (item) items.push(item);
          break;
        }
        case "tool-call": {
          // A partial call is UI state — the arguments were still streaming
          // when this was written down. It has no result and never had one, so
          // sending it would create exactly the dangling call the API rejects.
          if (part.partial) break;
          flush();
          items.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: String(part.name),
            arguments: JSON.stringify(part.input ?? {}),
          });
          break;
        }
        case "tool-result": {
          flush();
          items.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: toolResultOutput(part),
          });
          break;
        }
      }
    }

    flush();
  }

  return items;
}

function textContent(role: AgentMessage["role"], text: string): Record<string, unknown> {
  return { type: role === "assistant" ? "output_text" : "input_text", text };
}

/**
 * Reasoning goes back exactly as it came.
 *
 * Reshaping it — flattening the summary into text, renaming the item, dropping
 * the id — costs two things that are hard to see and expensive to have lost:
 * the prompt cache, which keys on the literal item, and on a reasoning model
 * the thread of the model's own argument across turns.
 *
 * An item with no id is dropped instead. The id is the API's handle on stored
 * reasoning, and an item without one is not a reasoning item the API can
 * resolve — sending a summary under a fabricated id would be worse than
 * sending nothing, because it would look like continuity that is not there.
 */
function reasoningItem(part: { id?: string; text?: string }): ResponsesInputItem | null {
  if (!part.id) return null;
  const item: ResponsesInputItem = { type: "reasoning", id: part.id };
  item.summary = part.text ? [{ type: "summary_text", text: part.text }] : [];
  return item;
}

/**
 * Every tool call gets an output, including the ones that never ran.
 *
 * The API rejects a history containing a `function_call` with no matching
 * `function_call_output`, so a denial cannot be expressed by omission — and a
 * conversation where the user said no has to stay continuable, which is the
 * whole reason `denied` exists in the first place.
 *
 * What is sent is prose rather than a status enum, because the reader is a
 * language model: it has to be able to tell "the user refused this" from "this
 * blew up", and those two lead to genuinely different next moves — apologize
 * and ask, versus try another way.
 */
export function toolResultOutput(part: ToolResultPart): string {
  if (part.status === "ok") {
    return typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? null);
  }

  if (part.status === "denied") {
    const reason = part.reason ? ` Reason given: ${part.reason}` : "";
    if (part.cause === "stopped") {
      return `The run was stopped before this tool call could complete, so it did not run.${reason}`;
    }
    return `The user declined this tool call, so it did not run.${reason}`;
  }

  return `The tool call failed and produced no result. Error (${part.error?.code ?? "unknown"}): ${
    part.error?.message ?? "no message"
  }`;
}

// --- tools ---------------------------------------------------------------

function isNamespace(
  entry: ProviderToolSpec | ProviderToolNamespace,
): entry is ProviderToolNamespace {
  return Array.isArray((entry as ProviderToolNamespace).tools);
}

/**
 * Tools and namespaces onto the Responses `tools` array.
 *
 * Without tool search the grouping has nothing to do — a namespace exists to be
 * searched — so it is flattened away and every schema is sent inline with
 * `deferred` ignored. That is the promise `capabilities.toolSearch` makes:
 * deferral is a token optimization, and an optimization that changed which
 * tools the model can reach would not be one.
 */
export function toResponsesTools(
  tools: (ProviderToolSpec | ProviderToolNamespace)[] | undefined,
  capabilities: ProviderCapabilities,
): ResponsesTool[] {
  if (!tools || tools.length === 0) return [];

  if (!capabilities.toolSearch) {
    const flat: ResponsesTool[] = [];
    for (const entry of tools) {
      if (isNamespace(entry)) {
        for (const tool of entry.tools) flat.push(functionTool(tool, false));
      } else {
        flat.push(functionTool(entry, false));
      }
    }
    return flat;
  }

  const out: ResponsesTool[] = [];
  let anyDeferred = false;

  for (const entry of tools) {
    if (isNamespace(entry)) {
      const inner = entry.tools.map((tool) => {
        if (tool.deferred) anyDeferred = true;
        return functionTool(tool, true);
      });
      out.push({
        type: "namespace",
        name: entry.name,
        description: entry.description,
        tools: inner,
      });
    } else {
      if (entry.deferred) anyDeferred = true;
      out.push(functionTool(entry, true));
    }
  }

  // Without this the deferred schemas are unreachable: the model is shown a
  // name and a description and given no way to ask for the rest, which is worse
  // than not deferring at all. Added only when something is actually deferred,
  // so an agent that defers nothing does not pay for a tool it cannot use.
  if (anyDeferred) out.push({ type: "tool_search" });

  return out;
}

function functionTool(tool: ProviderToolSpec, allowDeferred: boolean): ResponsesTool {
  const spec: ResponsesTool = {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  };
  if (allowDeferred && tool.deferred) spec.defer_loading = true;
  return spec;
}
