package dev.gemijs.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The message model of `ai/types.ts`, as typed views over JSON.
//
// Each class here holds the object the server sent (`json`) and reads its
// fields off it. Where `types.ts` has a union of string literals, Kotlin has a
// value class rather than an enum: a server one release ahead sends a reason
// this client has never heard of, and that must read, not throw.

/** Why a message or a run stopped. `types.ts` `FinishReason`. */
@JvmInline
public value class FinishReason(public val value: String) {
  public companion object {
    public val Stop: FinishReason = FinishReason("stop")
    public val Length: FinishReason = FinishReason("length")
    /** `maxSteps` was hit. Not an error, and not a finished answer either. */
    public val MaxSteps: FinishReason = FinishReason("max-steps")
    /** The run is over and the conversation is holding a question. */
    public val AwaitingInput: FinishReason = FinishReason("awaiting-input")
    public val Aborted: FinishReason = FinishReason("aborted")
    public val Error: FinishReason = FinishReason("error")
  }
}

public data class Usage(
  val inputTokens: Int,
  val outputTokens: Int,
  val reasoningTokens: Int?,
  val cachedInputTokens: Int?,
  val totalTokens: Int,
) {
  internal companion object {
    fun from(json: JsonElement?): Usage? {
      val obj = json.obj() ?: return null
      return Usage(
        inputTokens = obj["inputTokens"].int() ?: return null,
        outputTokens = obj["outputTokens"].int() ?: return null,
        reasoningTokens = obj["reasoningTokens"].int(),
        cachedInputTokens = obj["cachedInputTokens"].int(),
        totalTokens = obj["totalTokens"].int() ?: return null,
      )
    }
  }
}

public data class AgentError(val json: JsonObject) {
  public constructor(
    code: String,
    message: String,
    retryable: Boolean,
    toolCallId: String? = null,
  ) : this(
    jsonObjectOf(
      "code" to JsonPrimitive(code),
      "message" to JsonPrimitive(message),
      "retryable" to JsonPrimitive(retryable),
      "toolCallId" to toolCallId.json(),
    )
  )

  /** `types.ts` `AgentErrorCode`, e.g. `"rate_limited"` or `"thread_not_found"`. */
  val code: String get() = json.string("code") ?: "unknown"
  val message: String get() = json.string("message") ?: ""
  val toolCallId: String? get() = json.string("toolCallId")
  val retryable: Boolean get() = json["retryable"].bool() ?: false
}

/** Thrown where a suspending call has to fail with an `AgentError`. */
public class AgentException(public val error: AgentError) : Exception(error.message)

public data class AgentMessage(val json: JsonObject) {
  @JvmInline
  public value class Role(public val value: String) {
    public companion object {
      public val System: Role = Role("system")
      public val User: Role = Role("user")
      public val Assistant: Role = Role("assistant")
    }
  }

  val id: String get() = json.string("id") ?: ""
  val role: Role get() = Role(json.string("role") ?: "assistant")
  val content: List<ContentPart>
    get() = json["content"].array().orEmpty().map { ContentPart.from(it.obj() ?: JsonObject(emptyMap())) }
  val createdAt: String get() = json.string("createdAt") ?: ""
  /** Absent while the message is still streaming. */
  val finishReason: FinishReason? get() = json.string("finishReason")?.let(::FinishReason)
  val usage: Usage? get() = Usage.from(json["usage"])

  /** The text parts joined, which is what most UIs render as the body. */
  val text: String get() = content.filterIsInstance<ContentPart.Text>().joinToString("") { it.text }
}

/** One part of a message. `types.ts` `AgentContentPart`. */
public sealed interface ContentPart {
  public val json: JsonObject

  public data class Text(override val json: JsonObject) : ContentPart {
    val text: String get() = json.string("text") ?: ""
  }

  public data class Reasoning(override val json: JsonObject) : ContentPart {
    val id: String? get() = json.string("id")
    val text: String? get() = json.string("text")
  }

  public data class File(override val json: JsonObject) : ContentPart {
    /** The provider's file id: what the model is shown. */
    val fileId: String get() = json.string("fileId") ?: ""
    val name: String? get() = json.string("name")
    val mimeType: String? get() = json.string("mimeType")
    /** gemi's attachment id, when there is one — the handle a tool fetches the
     *  bytes by. Set on a file a tool showed the model, and on an upload the
     *  server kept. */
    val attachmentId: String? get() = json.string("attachmentId")
  }

  public data class ToolCall(override val json: JsonObject) : ContentPart {
    val toolCallId: String get() = json.string("toolCallId") ?: ""
    val name: String get() = json.string("name") ?: ""
    val input: JsonElement get() = json["input"] ?: JsonNull
    /** Set while the model is still streaming the arguments. */
    val partial: Boolean get() = json["partial"].bool() ?: false
    /** Everything the tool yielded, in order. */
    val progress: List<JsonElement> get() = json["progress"].array().orEmpty()
    /** Sub-agent runs this tool drove, in the order they started. */
    val nested: List<NestedRun>
      get() = json["nested"].array().orEmpty().map { NestedRun(it.obj() ?: JsonObject(emptyMap())) }
    /** What this call parked with `ctx.attachments.put`, in order — the
     *  server's memo, kept as it sent it. */
    val attachments: List<JsonElement> get() = json["attachments"].array().orEmpty()
  }

  public data class ToolResult(override val json: JsonObject) : ContentPart {
    val toolCallId: String get() = json.string("toolCallId") ?: ""
    val name: String get() = json.string("name") ?: ""

    public sealed interface Outcome {
      public data class Ok(val output: JsonElement) : Outcome
      public data class Error(val error: AgentError) : Outcome
      /** The call did not run: `"refused"` by the client, or `"stopped"` by a
       *  cancel that landed while it was in flight. */
      public data class Denied(val cause: String, val reason: String?) : Outcome
    }

    val outcome: Outcome
      get() =
        when (json.string("status")) {
          "error" -> Outcome.Error(AgentError(json["error"].obj() ?: JsonObject(emptyMap())))
          "denied" -> Outcome.Denied(json.string("cause") ?: "refused", json.string("reason"))
          else -> Outcome.Ok(json["output"] ?: JsonNull)
        }
  }

  /** The final answer of an agent with an `output` schema. */
  public data class Output(override val json: JsonObject) : ContentPart {
    val value: JsonElement get() = json["value"] ?: JsonNull
    /** True while the object is still being assembled from the token stream. */
    val partial: Boolean get() = json["partial"].bool() ?: false
  }

  /** A part type this client does not know — a newer server. */
  public data class Unknown(override val json: JsonObject) : ContentPart

  public companion object {
    public fun from(json: JsonObject): ContentPart =
      when (json.string("type")) {
        "text" -> Text(json)
        "reasoning" -> Reasoning(json)
        "file" -> File(json)
        "tool-call" -> ToolCall(json)
        "tool-result" -> ToolResult(json)
        "output" -> Output(json)
        else -> Unknown(json)
      }
  }
}

/** A sub-agent's run, recorded on the tool call that drove it. Its `messages`
 *  are an ordinary transcript, so whatever renders a chat renders this too. */
public data class NestedRun(val json: JsonObject) {
  val runId: String get() = json.string("runId") ?: ""
  val agent: String get() = json.string("agent") ?: ""
  val label: String? get() = json.string("label")
  val messages: List<AgentMessage>
    get() = json["messages"].array().orEmpty().map { AgentMessage(it.obj() ?: JsonObject(emptyMap())) }
  val finishReason: FinishReason? get() = json.string("finishReason")?.let(::FinishReason)
  val usage: Usage? get() = Usage.from(json["usage"])
}

/** A tool call the server will not complete on its own. `types.ts`
 *  `PendingToolCall`. */
public data class PendingToolCall(val json: JsonObject) {
  @JvmInline
  public value class Kind(public val value: String) {
    public companion object {
      /** The server can run it, but not without a person saying yes. */
      public val Approval: Kind = Kind("approval")
      /** The whole answer is the person's. */
      public val Question: Kind = Kind("question")
      /** Only the app can run it. */
      public val Client: Kind = Kind("client")
    }
  }

  val toolCallId: String get() = json.string("toolCallId") ?: ""
  val name: String get() = json.string("name") ?: ""
  val input: JsonElement get() = json["input"] ?: JsonNull
  val kind: Kind get() = Kind(json.string("kind") ?: "question")
  /** Handed back untouched with the answer. */
  val signature: String get() = json.string("signature") ?: ""
  /** The chain of tool calls a sub-agent's question is nested under,
   *  outermost first. Handed back untouched. */
  val path: List<String>? get() = json["path"].array()?.mapNotNull { it.string() }
}
