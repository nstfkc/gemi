package dev.gemijs.chat

import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Frames to a message list. A port of `ai/client/reducer.ts`, held to every
 * call its tests make (`ai/client/__fixtures__/reducer.json`).
 *
 * The rule it is built around: **a client may be handed any suffix of a run,
 * and may be handed the same frame twice.** Nothing tracks "the current
 * message"; every event names what it touches, `seq` refuses a redelivered
 * frame, and a finished message refuses a replayed delta. The TypeScript file
 * carries the long form of every decision below, and a change to one belongs
 * there first — the fixtures are regenerated from its tests.
 *
 * Written over the raw JSON, as a close transliteration, so the port can be
 * read side by side with the original.
 */
public data class ChatState(
  val messages: List<AgentMessage> = emptyList(),
  /** Non-empty exactly while the conversation is holding a question. */
  val pending: List<PendingToolCall> = emptyList(),
  val error: AgentError? = null,
  /** Set while a run is live. */
  val runId: String? = null,
  val threadId: String? = null,
  /** The highest frame applied: the cursor `/attach` resumes from. */
  val seq: Int = -1,
  /** Which run `seq` counts within. Outlives the run, unlike `runId`. */
  val cursorRunId: String? = null,
  /** The messages the run in hand has touched, oldest first. */
  val runMessageIds: List<String> = emptyList(),
  /** The deferred tools the model has loaded this run, as a set. */
  val loadedTools: List<String> = emptyList(),
  val finishReason: FinishReason? = null,
) {
  /**
   * Applies one frame. `null` when the frame was a replay and nothing
   * changed — the TypeScript reducer returning its input object — so a
   * caller can skip the callbacks it would otherwise fire twice.
   */
  public fun apply(frame: StreamFrame, now: String = timestamp()): ChatState? {
    val event = frame.event.obj() ?: JsonObject(emptyMap())
    // A `seq` numbers frames within one run, so a new run's `run-start` is the
    // one frame entitled to drop the cursor.
    val startsNewRun = event.string("type") == "run-start" && event.string("runId") != cursorRunId
    if (!startsNewRun && frame.seq <= seq) return null
    return reduce(event, now).copy(seq = frame.seq)
  }

  /** `markAborted`: the interrupted turn stays, marked cut short; a pending
   *  question stays too. */
  public fun markAborted(): ChatState =
    copy(runId = null, finishReason = FinishReason.Aborted, messages = finishUnended(FinishReason.Aborted))

  public companion object {
    /** `initialChatState`. `seq: -1` means "I have seen nothing". */
    public fun initial(
      messages: List<AgentMessage> = emptyList(),
      pending: List<PendingToolCall> = emptyList(),
      threadId: String? = null,
      seq: Int? = null,
      cursorRunId: String? = null,
    ): ChatState =
      ChatState(
        messages = messages,
        pending = pending,
        threadId = threadId,
        seq = seq ?: -1,
        cursorRunId = cursorRunId,
      )

    /** Now, as JavaScript's `toISOString` writes it — always milliseconds. */
    public fun timestamp(): String = ISO_MILLIS.format(Instant.now())

    private val ISO_MILLIS =
      java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
        .withZone(java.time.ZoneOffset.UTC)
  }

  // --- reduce ------------------------------------------------------------

  internal fun reduce(event: JsonObject, now: String): ChatState =
    when (event.string("type")) {
      "run-start" ->
        copy(
          runId = event.string("runId"),
          cursorRunId = event.string("runId"),
          threadId = event.string("threadId") ?: threadId,
          runMessageIds = emptyList(),
          loadedTools = emptyList(),
          finishReason = null,
        )

      "message-start" -> withMessage(event.string("messageId") ?: "", now) { it.with("role", event["role"]) }

      "text-delta" -> {
        val id = event.string("messageId") ?: ""
        if (isFinished(id)) this
        else withMessage(id, now) { it.with("content", JsonArray(appendText(it.content(), event.string("delta") ?: ""))) }
      }

      "reasoning-delta" -> {
        val id = event.string("messageId") ?: ""
        if (isFinished(id)) this
        else
          withMessage(id, now) {
            it.with("content", JsonArray(appendReasoning(it.content(), event.string("delta") ?: "", event["id"])))
          }
      }

      // `snapshot` is the whole object so far; replacing beats accumulating.
      "output-delta" ->
        withMessage(event.string("messageId") ?: "", now) { message ->
          val part = jsonObjectOf("type" to JsonPrimitive("output"), "value" to event["snapshot"], "partial" to JsonPrimitive(true))
          message.with("content", JsonArray(upsert(message.content(), part) { it.string("type") == "output" }))
        }

      // Merged, not replaced: `progress` and `nested` are the execution's half
      // of the part and arrive on events that name no message.
      "tool-call" -> {
        val eventPart = event["part"].obj() ?: JsonObject(emptyMap())
        val toolCallId = eventPart["toolCallId"]
        withMessage(event.string("messageId") ?: "", now) { message ->
          val content = message.content().toMutableList()
          val index = content.indexOfFirst { it.obj()?.string("type") == "tool-call" && it.obj()?.get("toolCallId") == toolCallId }
          val existing = if (index == -1) null else content[index].obj()
          var part = eventPart
          (eventPart["progress"].nonNull() ?: existing?.get("progress").nonNull())?.let { part = part.with("progress", it) }
          (eventPart["nested"].nonNull() ?: existing?.get("nested").nonNull())?.let { part = part.with("nested", it) }
          // The memo `ctx.attachments.put` replays from: a stateless client that
          // dropped it would have a re-entered tool store and upload its bytes again.
          (eventPart["attachments"].nonNull() ?: existing?.get("attachments").nonNull())?.let {
            part = part.with("attachments", it)
          }
          if (index == -1) content.add(part) else content[index] = part
          message.with("content", JsonArray(content))
        }
      }

      // A set: union is the only accumulation that survives redelivery with
      // nothing to key it on.
      "tool-search" -> {
        val loaded = event["loaded"].array().orEmpty().mapNotNull { it.string() }.filter { it !in loadedTools }
        if (loaded.isEmpty()) this else copy(loadedTools = loadedTools + loaded)
      }

      "tool-progress" -> {
        val data = event["data"] ?: kotlinx.serialization.json.JsonNull
        withToolCall(event["toolCallId"]) { part -> part.with("progress", JsonArray(part["progress"].array().orEmpty() + data)) }
      }

      // The recursion: a sub-run's transcript is reduced by this same code.
      "nested-event" ->
        withToolCall(event["toolCallId"]) { part ->
          val runs = part["nested"].array().orEmpty().toMutableList()
          val index = runs.indexOfFirst { it.obj()?.get("runId") == event["runId"] }
          val run =
            (if (index == -1) null else runs[index].obj())
              ?: jsonObjectOf("runId" to event["runId"], "agent" to event["agent"], "messages" to JsonArray(emptyList()))
          val next = applyNested(run, event, now)
          if (index == -1) runs.add(next) else runs[index] = next
          part.with("nested", JsonArray(runs))
        }

      "tool-result" -> {
        val eventPart = event["part"].obj() ?: JsonObject(emptyMap())
        val toolCallId = eventPart["toolCallId"]
        val next =
          withMessage(event.string("messageId") ?: "", now) { message ->
            message.with(
              "content",
              JsonArray(upsert(message.content(), eventPart) { it.string("type") == "tool-result" && it["toolCallId"] == toolCallId }),
            )
          }
        // Answered, whoever answered it, so no longer pending.
        next.copy(pending = next.pending.filter { it.json["toolCallId"] != toolCallId })
      }

      // A whole message the server wrote — a tool's `showModel` file today —
      // replaced or appended by id. Its one author is the server and it is
      // complete when sent, so replacing loses nothing, and it is not created
      // through `withMessage`, which would make it an assistant's.
      "message" -> {
        val message = event["message"].obj()
        if (message == null) this
        else {
          val index = messages.indexOfFirst { it.json["id"] == message["id"] }
          val id = message.string("id") ?: ""
          copy(
            messages = if (index == -1) messages + AgentMessage(message) else messages.toMutableList().also { it[index] = AgentMessage(message) },
            runMessageIds = if (id in runMessageIds) runMessageIds else runMessageIds + id,
          )
        }
      }

      "awaiting-input" ->
        copy(
          runId = event.string("runId"),
          pending = event["pending"].array().orEmpty().map { PendingToolCall(it.obj() ?: JsonObject(emptyMap())) },
        )

      "message-end" ->
        withMessage(event.string("messageId") ?: "", now) { message ->
          message
            .with("finishReason", event["finishReason"])
            .with(
              "content",
              JsonArray(
                message.content().map { value ->
                  val part = value.obj()
                  if (part != null && part.string("type") == "output" && part["partial"].bool() == true) {
                    part.with("partial", JsonPrimitive(false))
                  } else value
                }
              ),
            )
        }

      // On the last assistant message, never on the user's own turn.
      "usage" -> {
        val index = messages.indexOfLast { it.json.string("role") == "assistant" }
        if (index == -1) this
        else copy(messages = messages.toMutableList().also { it[index] = AgentMessage(it[index].json.with("usage", event["usage"])) })
      }

      "error" -> copy(error = event["error"].obj()?.let(::AgentError), pending = emptyList())

      "run-end" -> {
        val reason = event.string("finishReason")?.let(::FinishReason)
        copy(runId = null, finishReason = reason, messages = finishUnended(reason))
      }

      // A newer server's event. Ignored, and the seq still advances.
      else -> this
    }

  // --- closing a run -----------------------------------------------------

  /** This run's messages finished off with `reason` if they never ended, and
   *  the sub-runs inside them too. */
  internal fun finishUnended(reason: FinishReason?): List<AgentMessage> =
    messages.map { message ->
      if (message.json.string("role") == "assistant" && message.id in runMessageIds) closeMessage(message, reason) else message
    }

  // --- helpers -----------------------------------------------------------

  /** Updates the tool-call part with this id, wherever it lives. A frame for a
   *  call this transcript does not have is dropped. */
  private fun withToolCall(toolCallId: JsonElement?, update: (JsonObject) -> JsonObject): ChatState {
    for (i in messages.indices.reversed()) {
      val message = messages[i]
      val content = message.json.content().toMutableList()
      val index = content.indexOfFirst { it.obj()?.string("type") == "tool-call" && it.obj()?.get("toolCallId") == toolCallId }
      if (index == -1) continue
      // A finished message refuses the frame as replay — unless the run parked
      // on it and this call is still open, which is the resume turn.
      if (message.json["finishReason"] != null && !isReenterable(message, toolCallId)) return this
      content[index] = update(content[index].obj() ?: JsonObject(emptyMap()))
      val updated = messages.toMutableList().also { it[i] = AgentMessage(message.json.with("content", JsonArray(content))) }
      return copy(
        messages = updated,
        runMessageIds = if (message.id in runMessageIds) runMessageIds else runMessageIds + message.id,
      )
    }
    return this
  }

  private fun isReenterable(message: AgentMessage, toolCallId: JsonElement?): Boolean {
    if (message.json.string("finishReason") != FinishReason.AwaitingInput.value) return false
    return messages.none { candidate ->
      candidate.json.content().any { it.obj()?.string("type") == "tool-result" && it.obj()?.get("toolCallId") == toolCallId }
    }
  }

  private fun isFinished(messageId: String): Boolean =
    messages.firstOrNull { it.id == messageId }?.let { it.json["finishReason"] != null } ?: false

  /** Updates the message with this id, creating it if the list never saw it
   *  start — the mid-stream attach. */
  private fun withMessage(messageId: String, now: String, update: (JsonObject) -> JsonObject): ChatState {
    val ids = if (messageId in runMessageIds) runMessageIds else runMessageIds + messageId
    val index = messages.indexOfFirst { it.id == messageId }
    return if (index == -1) {
      val blank =
        jsonObjectOf(
          "id" to JsonPrimitive(messageId),
          "role" to JsonPrimitive("assistant"),
          "content" to JsonArray(emptyList()),
          "createdAt" to JsonPrimitive(now),
        )
      copy(runMessageIds = ids, messages = messages + AgentMessage(update(blank)))
    } else {
      copy(runMessageIds = ids, messages = messages.toMutableList().also { it[index] = AgentMessage(update(it[index].json)) })
    }
  }
}

/** A sub-run event applied to the sub-run's own transcript, through a state
 *  built for the purpose and thrown away. */
private fun applyNested(run: JsonObject, event: JsonObject, now: String): JsonObject {
  val sub = nestedState(messagesOf(run)).copy(finishReason = run.string("finishReason")?.let(::FinishReason))
  val inner = event["event"].obj() ?: JsonObject(emptyMap())
  val next = sub.reduce(inner, now)
  var result = run
  event["label"]?.let { result = result.with("label", it) }
  result = result.with("messages", JsonArray(next.messages.map { it.json }))
  next.finishReason?.let { result = result.with("finishReason", JsonPrimitive(it.value)) }
  if (inner.string("type") == "usage") result = result.with("usage", inner["usage"])
  return result
}

/** The state a nested transcript is reduced and closed through: every message
 *  is the run's own, and a sub-run's pending copy is never surfaced. */
private fun nestedState(messages: List<AgentMessage>) = ChatState(messages = messages, runMessageIds = messages.map { it.id })

private fun closeMessage(message: AgentMessage, reason: FinishReason?): AgentMessage {
  var changed = false
  val closed =
    message.json.content().map { value ->
      val part = value.obj()
      val nested = part?.get("nested").array()
      if (part == null || part.string("type") != "tool-call" || nested == null || nested.none { it.obj()?.get("finishReason") == null }) {
        value
      } else {
        changed = true
        part.with(
          "nested",
          JsonArray(nested.map { run -> if (run.obj()?.get("finishReason") == null) closeRun(run.obj() ?: JsonObject(emptyMap()), reason) else run }),
        )
      }
    }
  if (message.json["finishReason"] == null) {
    return AgentMessage(message.json.with("finishReason", reason?.value.json()).with("content", JsonArray(closed)))
  }
  return if (changed) AgentMessage(message.json.with("content", JsonArray(closed))) else message
}

private fun closeRun(run: JsonObject, reason: FinishReason?): JsonObject =
  run
    .with("finishReason", reason?.value.json())
    .with("messages", JsonArray(nestedState(messagesOf(run)).finishUnended(reason).map { it.json }))

private fun messagesOf(run: JsonObject): List<AgentMessage> =
  run["messages"].array().orEmpty().map { AgentMessage(it.obj() ?: JsonObject(emptyMap())) }

private fun JsonObject.content(): List<JsonElement> = this["content"].array().orEmpty()

/** Coalesced into the trailing text part only if it *is* trailing, so text
 *  after a tool call opens a new part. */
private fun appendText(content: List<JsonElement>, delta: String): List<JsonElement> {
  val last = content.lastOrNull().obj()
  if (last != null && last.string("type") == "text") {
    return content.dropLast(1) + jsonObjectOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive((last.string("text") ?: "") + delta))
  }
  return content + jsonObjectOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(delta))
}

/** Joins the last part only when the reasoning-item id matches, as
 *  `appendReasoning` in `Agent.ts` does. */
private fun appendReasoning(content: List<JsonElement>, delta: String, id: JsonElement?): List<JsonElement> {
  val last = content.lastOrNull().obj()
  if (last != null && last.string("type") == "reasoning" && last["id"] == id) {
    return content.dropLast(1) + last.with("text", JsonPrimitive((last.string("text") ?: "") + delta))
  }
  return content +
    if (id != null && id.truthy()) jsonObjectOf("type" to JsonPrimitive("reasoning"), "id" to id, "text" to JsonPrimitive(delta))
    else jsonObjectOf("type" to JsonPrimitive("reasoning"), "text" to JsonPrimitive(delta))
}

private fun upsert(content: List<JsonElement>, part: JsonObject, match: (JsonObject) -> Boolean): List<JsonElement> {
  val index = content.indexOfFirst { match(it.obj() ?: JsonObject(emptyMap())) }
  return if (index == -1) content + part else content.toMutableList().also { it[index] = part }
}
