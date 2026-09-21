package dev.gemijs.chat

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement

/**
 * An agent's tool and output types, as `gemi ai:generate-client` writes them.
 *
 * The transcript stays JSON; a schema is how a UI reads it typed.
 * `SupportAgent.toolCall(part)` turns a raw part into
 * `ToolCall.Grep(TypedToolCall<GrepInput, Nothing>)`, which a `when` narrows
 * exactly as `part.name === "grep"` narrows the TypeScript union.
 *
 * Every view has an `Unknown` case, because the server is not obliged to match
 * the generated file: a tool added since the last generate, a skill (lowered
 * to a tool the agent's types never list), or a payload that no longer decodes
 * all land there instead of failing the message.
 */
public interface AgentSchema<ToolCall, ToolResult, Pending, Output> {
  public fun toolCall(part: ContentPart.ToolCall): ToolCall

  public fun toolResult(part: ContentPart.ToolResult): ToolResult

  public fun pending(call: PendingToolCall): Pending

  /** `null` for an agent with no `output` schema. */
  public val outputSerializer: KSerializer<Output>?

  /**
   * The typed final answer, once it parses. A partial snapshot usually does
   * not — required members are still missing — so this is `null` until it
   * does, and `part.value` has what has arrived so far.
   */
  public fun output(part: ContentPart.Output): Output? = outputSerializer?.let { decodeOrNull(it, part.value) }
}

/** The schema of an agent nothing was generated for: every view is the raw part. */
public object UntypedAgent : AgentSchema<ContentPart.ToolCall, ContentPart.ToolResult, PendingToolCall, JsonElement> {
  override fun toolCall(part: ContentPart.ToolCall): ContentPart.ToolCall = part

  override fun toolResult(part: ContentPart.ToolResult): ContentPart.ToolResult = part

  override fun pending(call: PendingToolCall): PendingToolCall = call

  override val outputSerializer: KSerializer<JsonElement> = JsonElement.serializer()
}

/** A tool call with its payloads decoded. */
public class TypedToolCall<Input, Progress>(
  public val part: ContentPart.ToolCall,
  input: KSerializer<Input>,
  /** `null` for a tool that cannot yield. */
  progress: KSerializer<Progress>?,
) {
  /** `null` while the model is still streaming the arguments (`part.partial`)
   *  and they do not yet make a whole `Input`. */
  public val input: Input? = decodeOrNull(input, part.input)

  /** What the tool has yielded so far, in order. An entry that does not decode
   *  is left out; `part.progress` has every one raw. */
  public val progress: List<Progress> =
    progress?.let { serializer -> part.progress.mapNotNull { decodeOrNull(serializer, it) } } ?: emptyList()

  public val toolCallId: String get() = part.toolCallId

  /** Sub-agent runs this call drove. Their tools are the sub-agent's, so their
   *  transcripts are untyped here, as they are in TypeScript. */
  public val nested: List<NestedRun> get() = part.nested

  override fun equals(other: Any?): Boolean = other is TypedToolCall<*, *> && other.part == part

  override fun hashCode(): Int = part.hashCode()

  override fun toString(): String = "TypedToolCall(${part.name}, input=$input, progress=$progress)"
}

/** A tool result with its output decoded. */
public class TypedToolResult<Output>
private constructor(public val part: ContentPart.ToolResult, public val outcome: Outcome<Output>) {
  public sealed interface Outcome<out Output> {
    public data class Ok<Output>(val output: Output) : Outcome<Output>

    public data class Error(val error: AgentError) : Outcome<Nothing>

    /** The call did not run: `"refused"` by the client, or `"stopped"` by a
     *  cancel that landed while it was in flight. */
    public data class Denied(val cause: String, val reason: String?) : Outcome<Nothing>
  }

  public val toolCallId: String get() = part.toolCallId

  override fun equals(other: Any?): Boolean = other is TypedToolResult<*> && other.part == part

  override fun hashCode(): Int = part.hashCode()

  override fun toString(): String = "TypedToolResult(${part.name}, $outcome)"

  public companion object {
    /** `null` when the result is `ok` but its output does not decode. */
    public fun <Output> of(part: ContentPart.ToolResult, output: KSerializer<Output>): TypedToolResult<Output>? {
      val outcome: Outcome<Output> =
        when (val raw = part.outcome) {
          is ContentPart.ToolResult.Outcome.Ok -> Outcome.Ok(decodeOrNull(output, raw.output) ?: return null)
          is ContentPart.ToolResult.Outcome.Error -> Outcome.Error(raw.error)
          is ContentPart.ToolResult.Outcome.Denied -> Outcome.Denied(raw.cause, raw.reason)
        }
      return TypedToolResult(part, outcome)
    }
  }
}

/**
 * A pending call with its input decoded, and the type of the answer it takes.
 * `ChatSession.answer(call, output)` accepts an `Output` for it — for a
 * question, the tool's output schema — so a wrong-shaped answer does not
 * compile.
 */
public class TypedPendingCall<Input, Output>(
  public val call: PendingToolCall,
  input: KSerializer<Input>,
  /** How an answer is encoded. */
  public val output: KSerializer<Output>,
) {
  public val input: Input? = decodeOrNull(input, call.input)
  public val toolCallId: String get() = call.toolCallId
  public val kind: PendingToolCall.Kind get() = call.kind

  override fun equals(other: Any?): Boolean = other is TypedPendingCall<*, *> && other.call == call

  override fun hashCode(): Int = call.hashCode()

  override fun toString(): String = "TypedPendingCall(${call.name}, input=$input)"
}

internal fun <T> decodeOrNull(serializer: KSerializer<T>, json: JsonElement): T? =
  try {
    GemiJson.decodeFromJsonElement(serializer, json)
  } catch (_: Exception) {
    null
  }
