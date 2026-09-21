package dev.gemijs.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One turn from the client: text, files, answers to pending calls, or any mix.
 * `types.ts` `ClientTurn`.
 *
 * A turn that leaves a pending call unanswered denies it, so answers to
 * several calls belong in one turn — which is what `ChatSession.approve` and
 * `answer` arrange.
 */
public data class ClientTurn(
  val text: String? = null,
  val files: List<ChatFile> = emptyList(),
  val toolResults: List<ClientToolResult> = emptyList(),
) {
  internal val json: JsonObject
    get() =
      jsonObjectOf(
        "text" to text.json(),
        "files" to files.takeIf { it.isNotEmpty() }?.let { list -> JsonArray(list.map { it.json }) },
        "toolResults" to toolResults.takeIf { it.isNotEmpty() }?.let { list -> JsonArray(list.map { it.json }) },
      )
}

/** An uploaded file, as `ChatSession.upload` returns it and a turn carries it. */
public data class ChatFile(val fileId: String, val name: String? = null, val mimeType: String? = null) {
  internal val json: JsonObject
    get() = jsonObjectOf("fileId" to JsonPrimitive(fileId), "name" to name.json(), "mimeType" to mimeType.json())
}

/**
 * What `ChatSession.upload` returns: the two handles the server may give a
 * file, either of which can be absent.
 *
 * `fileId` is the provider's — what goes in a turn's `files`, and what the
 * model is shown. `attachmentId` is gemi's — the handle a tool fetches the
 * bytes by, which an app passes to the agent in its own words or payload. A
 * file the server kept but never sent to the provider has no `fileId`; an
 * upload the server had no scope to keep has no `attachmentId`. See
 * `AgentController.attachmentScope`.
 */
public data class ChatUpload(
  val fileId: String? = null,
  val attachmentId: String? = null,
  val name: String,
  val mimeType: String,
  /** Set when the server wanted to keep the file and had no scope to keep it
   *  under — a missing `attachmentId` that is a misconfigured route rather
   *  than the app's policy. `"no_scope"` today. */
  val downgraded: String? = null,
) {
  /** The file to put in a turn's `files`, when the provider has it. */
  val file: ChatFile? get() = fileId?.let { ChatFile(it, name, mimeType) }
}

/**
 * The client's half of a pending call. `types.ts` `ClientToolResult`.
 *
 * `signature` and `path` are the pending call's, handed back untouched: they
 * stop an answer being applied to a call — or an input — it was not given
 * for. `ChatSession` fills them in; an app answers by id.
 */
public sealed interface ClientToolResult {
  public val toolCallId: String
  public val signature: String
  public val path: List<String>?

  public data class Approval(
    override val toolCallId: String,
    override val signature: String,
    override val path: List<String>?,
    val approve: Boolean,
    val reason: String? = null,
  ) : ClientToolResult

  /** For `question` and `client` calls: the value itself, checked against the
   *  tool's output schema on the server before the model sees it. */
  public data class Output(
    override val toolCallId: String,
    override val signature: String,
    override val path: List<String>?,
    val output: JsonElement,
  ) : ClientToolResult

  public val json: JsonObject
    get() {
      val base =
        jsonObjectOf(
          "toolCallId" to JsonPrimitive(toolCallId),
          "signature" to JsonPrimitive(signature),
          "path" to path?.let { list -> JsonArray(list.map(::JsonPrimitive)) },
        )
      return when (this) {
        is Approval -> base.with("approve", JsonPrimitive(approve)).with("reason", reason.json())
        is Output -> base.with("output", output)
      }
    }
}
