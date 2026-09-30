import type { ProviderStreamParams } from "./AgentProvider";
import { supportsStrict, type Schema } from "./Schema";
import type { AgentError, AgentMessage, Usage } from "./types";

/**
 * What one model call needs, whether the agent loop makes it or `generate` does.
 *
 * Moved out of `Agent.ts` rather than copied when `generate` arrived (#594).
 * `generate` is the agent's step without the loop around it — assemble one
 * call, read the stream, parse the answer — so each of these would otherwise
 * exist twice, and the two copies of "how is a structured answer parsed" or
 * "how is usage summed" are exactly the kind that drift apart unnoticed.
 *
 * Internal. Nothing here is exported from `gemi/ai`.
 */

// --- aborting --------------------------------------------------------------

export class RunAborted extends Error {
  constructor() {
    super("The run was stopped");
    this.name = "RunAborted";
  }
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new RunAborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RunAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// --- usage -----------------------------------------------------------------

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(total: Usage, next: Usage | undefined): Usage {
  if (!next) return total;
  const merged: Usage = {
    inputTokens: total.inputTokens + (next.inputTokens ?? 0),
    outputTokens: total.outputTokens + (next.outputTokens ?? 0),
    totalTokens: total.totalTokens + (next.totalTokens ?? 0),
  };
  if (next.reasoningTokens !== undefined || total.reasoningTokens !== undefined) {
    merged.reasoningTokens = (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  }
  if (next.cachedInputTokens !== undefined || total.cachedInputTokens !== undefined) {
    merged.cachedInputTokens = (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  }
  if (next.imageInputTokens !== undefined || total.imageInputTokens !== undefined) {
    merged.imageInputTokens = (total.imageInputTokens ?? 0) + (next.imageInputTokens ?? 0);
  }
  if (next.imageOutputTokens !== undefined || total.imageOutputTokens !== undefined) {
    merged.imageOutputTokens = (total.imageOutputTokens ?? 0) + (next.imageOutputTokens ?? 0);
  }
  return merged;
}

// --- structured output -----------------------------------------------------

/**
 * The best parse of a JSON document that is still arriving.
 *
 * Exists so a UI can bind fields before the object closes. It closes whatever
 * brackets are open and drops a trailing key with no value; when even that does
 * not parse it gives up and returns an empty object rather than throwing,
 * because a snapshot is a convenience and a run must not die for one.
 */
export function bestEffortParse(text: string): any {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    // fall through to repair
  }
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") closers.push("}");
    else if (char === "[") closers.push("]");
    else if (char === "}" || char === "]") closers.pop();
  }
  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/[,:]\s*$/, "");
  const suffix = closers.reverse().join("");
  try {
    return JSON.parse(repaired + suffix);
  } catch {
    // A trailing `"key":` leaves a property with no value; drop the key too.
    try {
      return JSON.parse(repaired.replace(/,?\s*"[^"]*"\s*$/, "") + suffix);
    } catch {
      return {};
    }
  }
}
/**
 * The `output` parameter a provider is sent for a schema.
 *
 * `strict` is read off the schema, never chosen: an `s.json()` node anywhere in
 * it has no spelling in strict mode, so a schema containing one is sent
 * non-strict and the provider does not answer 400.
 */
export function outputFormat(schema: Schema<any>): NonNullable<ProviderStreamParams["output"]> {
  return { name: "output", schema: schema.toJSONSchema(), strict: supportsStrict(schema) };
}

/**
 * A finished structured answer, checked against its schema.
 *
 * The failure is an `AgentError` with `code: "invalid_output"` rather than the
 * schema's own `errors: string[]`, so a caller branches on a code the way it
 * does for `invalid_tool_input`, and the list is joined into the message for a
 * person — or a retry prompt — to read.
 *
 * `bestEffortParse`, not `JSON.parse`, for the reason the agent loop has always
 * used it: the text is the whole answer by now, so the repair has nothing to
 * close, and a document that still does not parse comes back `{}` and fails the
 * schema with a message naming what is missing, instead of a `SyntaxError`
 * position nobody can act on. A cut-off answer never reaches here — see the
 * `length` checks in both callers — because a repaired prefix can pass a loose
 * schema and look finished.
 */
export function parseOutput<T>(
  schema: Schema<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: AgentError } {
  const parsed = schema.safeParse(bestEffortParse(text));
  if (parsed.ok === true) return { ok: true, value: parsed.value };
  return {
    ok: false,
    error: {
      code: "invalid_output",
      message: `The model's structured answer did not match the output schema: ${parsed.errors.join(", ")}`,
      retryable: true,
    },
  };
}

// --- building the assistant message ----------------------------------------

/**
 * Resolves a string built by repeated concatenation, in place.
 *
 * `text = text + delta`, run once per streamed token, does not build a string —
 * it builds a rope: a tree of pointers to every fragment, which the engine
 * flattens only when something needs the characters contiguously. A message
 * that nothing reads before it is persisted therefore keeps all of its
 * fragments alive, and the tree costs several times the text.
 *
 * Measured on Bun 1.x, 600 deltas of six characters (a ~450-token answer, 3.5 KB
 * of ASCII): held as a rope, 18.7 KB. Resolved, 3.5 KB — half the UTF-16 size,
 * because a flat ASCII string is stored one byte per character and a rope
 * cannot be. That is 5.3x, and it is paid by every message a store keeps and
 * every run the live registry holds.
 *
 * Indexing is what forces the resolution: `text[0]` cannot be answered without
 * the characters, so the engine collapses the tree and drops the fragments.
 * Nothing is allocated and nothing is copied, which is why this is not
 * `split("").join("")` — that measures the same but allocates one string per
 * character to get there.
 *
 * DO NOT DELETE THIS AS A NO-OP. It reads like one and it is not; the value is
 * the side effect on the receiver. If a future engine does not resolve on
 * index, this silently becomes a real no-op and memory returns to what it is
 * today — a safe failure, which is why it is written as a hint rather than as a
 * round trip through an encoder that would also mangle a lone surrogate.
 */
export function resolveRope(text: string): string {
  if (text.length > 0) void text[0];
  return text;
}

export function appendText(message: AgentMessage, type: "text" | "reasoning", delta: string) {
  const last = message.content[message.content.length - 1];
  if (last && last.type === type) {
    (last as { text?: string }).text = ((last as { text?: string }).text ?? "") + delta;
    return;
  }
  message.content.push(
    type === "text" ? { type: "text", text: delta } : { type: "reasoning", text: delta },
  );
}

/**
 * Reasoning is accumulated per ITEM, not per message, and the item's id is kept.
 *
 * This used to go through `appendText`, which merges on the part *type* alone
 * and has nowhere to put an id. Both halves of that were wrong and neither was
 * visible in the transcript:
 *
 *   - `request.ts` drops a reasoning item with no id, deliberately — the id is
 *     the API's handle on the stored reasoning and a fabricated one would look
 *     like continuity that is not there. So an id dropped here meant reasoning
 *     was never sent back at all: on a two-step run the model re-derived its
 *     own argument from nothing, and the prompt cache (which keys on the
 *     literal item) missed every time. Measured against the live Responses API
 *     in `live/live.test.ts`: the second call's input carried zero reasoning
 *     items.
 *   - a step that produces two reasoning items was flattening them into one
 *     part, so even with an id there would have been one id for two items'
 *     text.
 *
 * A part with no id is still appended rather than dropped: the text is what a
 * UI renders, and a provider that reports no item id (Azure does not always)
 * should still show its thinking. It just cannot be echoed back, which is the
 * bargain `reasoningItem` already documents.
 */
export function appendReasoning(message: AgentMessage, id: string | undefined, delta: string) {
  const last = message.content[message.content.length - 1];
  if (last && last.type === "reasoning" && last.id === id) {
    last.text = (last.text ?? "") + delta;
    return;
  }
  message.content.push(
    id ? { type: "reasoning", id, text: delta } : { type: "reasoning", text: delta },
  );
}
