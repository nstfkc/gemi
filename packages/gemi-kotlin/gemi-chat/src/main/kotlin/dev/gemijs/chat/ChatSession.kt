package dev.gemijs.chat

import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What the UI is waiting on. `useChat`'s `ChatStatus`.
 *
 * `AwaitingInput` is its own state rather than a flavour of idle: the run is
 * over, but the conversation is holding a question.
 */
public enum class ChatStatus { Idle, Submitted, Streaming, AwaitingInput, Error }

/** Where a client left off in a run: what `/attach` resumes from. Persist it
 *  beside the messages — restoring one without the other is how an answer
 *  ends up printed twice. */
public data class ChatCursor(val runId: String?, val seq: Int)

/** Everything a chat screen renders, as one value. */
public data class ChatUiState(
  /** The transcript, tools and all. Read a part typed with the generated
   *  schema: `SupportAgent.toolCall(part)`. */
  val messages: List<AgentMessage>,
  /** Non-empty exactly when `status == AwaitingInput`. */
  val pending: List<PendingToolCall>,
  /** Cleared by the next send, so a retry does not have to clear it. */
  val error: AgentError?,
  val status: ChatStatus,
  /** Set once the server has assigned one. */
  val threadId: String?,
  /** The run being streamed or attached to, if any. */
  val runId: String?,
  /** How far this client has got. Persist it with `messages`. */
  val cursor: ChatCursor,
  /** The deferred tools the model has pulled in during the run in flight. */
  val loadedTools: List<String>,
)

/**
 * A conversation with a gemi agent: `useChat` for Android.
 *
 * A port of `ai/useChat.tsx`, and deliberately a close one — the web hook's
 * comments carry the reasoning for each behaviour below, and a change to one
 * belongs there first. The frame handling is the shared reducer (`ChatState`),
 * held to the TypeScript one by the recorded corpus.
 *
 *     val chat = ChatSession(
 *       endpoint = "https://example.com/api/support",
 *       scope = viewModelScope,
 *       headers = { mapOf("Authorization" to "Bearer ${tokens.current()}") },
 *     )
 *     chat.send("Where is my order?")
 *
 * Confined to one thread, like the UI it feeds: call it from the thread
 * `scope` dispatches to — the main one, for `viewModelScope` — and its work
 * runs there too, apart from the network.
 *
 * @param endpoint the agent's route. `/stop`, `/attach` and `/files` hang off it.
 * @param threadId continues a server-side thread. Omitted, the session keeps
 *   the history and sends it with each turn — the stateless default.
 * @param attach pick up a run still going on `threadId`.
 * @param headers asked before every request, so a token that rotates is current.
 * @param body merged into every send's body.
 */
public class ChatSession(
  public val endpoint: String,
  private val scope: CoroutineScope,
  threadId: String? = null,
  initialMessages: List<AgentMessage> = emptyList(),
  cursor: ChatCursor? = null,
  attach: Boolean = true,
  public var headers: suspend () -> Map<String, String> = { emptyMap() },
  public var body: JsonObject = JsonObject(emptyMap()),
  private val transport: ChatTransport = OkHttpTransport(),
) {
  private var chat = ChatState.initial(messages = initialMessages, threadId = threadId, seq = cursor?.seq, cursorRunId = cursor?.runId)
  private var phase = Phase.Idle

  private enum class Phase { Idle, Submitted, Streaming }

  private val _state = MutableStateFlow(uiState())
  public val state: StateFlow<ChatUiState> = _state.asStateFlow()

  public var onFinish: ((AgentMessage) -> Unit)? = null
  public var onError: ((AgentError) -> Unit)? = null
  public var onAwaitingInput: ((List<PendingToolCall>) -> Unit)? = null
  /** The attach probe found no run. On more than one server instance that is
   *  ambiguous — the run may be alive on another one — and re-reading the
   *  thread is how an app shows the answer anyway. */
  public var onAttachMiss: ((String) -> Unit)? = null

  /** The request in flight and the id `stop()` names it by. */
  private var inFlight: InFlight? = null

  private class InFlight(val id: Any, val job: Job, val clientRunId: String?)

  /** Answers queued in one turn of the thread, sent as one turn. */
  private var queued: Pair<MutableList<ClientToolResult>, Job>? = null

  init {
    if (attach && threadId != null) attachToRun(threadId)
  }

  private fun uiState(): ChatUiState =
    ChatUiState(
      messages = chat.messages,
      pending = chat.pending,
      error = chat.error,
      // Ordered so `pending` non-empty exactly when awaiting input is true by
      // construction.
      status =
        when {
          chat.pending.isNotEmpty() -> ChatStatus.AwaitingInput
          phase == Phase.Submitted -> ChatStatus.Submitted
          phase == Phase.Streaming -> ChatStatus.Streaming
          chat.error != null -> ChatStatus.Error
          else -> ChatStatus.Idle
        },
      threadId = chat.threadId,
      runId = chat.runId,
      cursor = ChatCursor(chat.cursorRunId, chat.seq),
      loadedTools = chat.loadedTools,
    )

  private fun publish() {
    _state.value = uiState()
  }

  // --- sending -------------------------------------------------------------

  /** Sends text. */
  public suspend fun send(text: String): Unit = send(ClientTurn(text = text))

  /** Sends a turn. Answers to pending calls may travel with text. */
  public suspend fun send(turn: ClientTurn): Unit = start(turn).join()

  /**
   * Starts a turn and returns the job streaming it. Everything up to the
   * request going out happens before this returns, which is what lets
   * `approve` coalesce and `stop` see the turn it is stopping.
   */
  private fun start(turn: ClientTurn): Job {
    // One run at a time. A second send while the first streams is a user who
    // changed their mind; the superseded turn is marked aborted as it is cut.
    val superseded = inFlight
    superseded?.job?.cancel()
    val clientRunId = localId()

    if (superseded != null) {
      // Cancelling closes the connection, and that no longer stops a run, so
      // the superseded one is stopped by the handles that name exactly it —
      // never by `threadId`, which may already name the run this turn starts.
      val stopBody = jsonObjectOf("runId" to chat.runId.json(), "clientRunId" to superseded.clientRunId.json())
      if (stopBody.isNotEmpty()) {
        // Not awaited, and a failure is only reported without a thread: with
        // one, the server ends the old run when this turn reaches it.
        val report: (AgentError) -> Unit = if (chat.threadId == null) { error -> onError?.invoke(error) } else { _ -> }
        scope.launch { postStop(stopBody, report) }
      }
      chat = chat.markAborted()
    }

    val history = chat.messages
    val authored =
      if (!turn.text.isNullOrEmpty() || turn.files.isNotEmpty()) {
        val content =
          listOfNotNull(turn.text?.takeIf { it.isNotEmpty() }?.let { jsonObjectOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(it)) }) +
            turn.files.map { it.json.with("type", JsonPrimitive("file")) }
        listOf(
          AgentMessage(
            jsonObjectOf(
              "id" to JsonPrimitive(localId()),
              "role" to JsonPrimitive("user"),
              "content" to JsonArray(content),
              "createdAt" to JsonPrimitive(ChatState.timestamp()),
            )
          )
        )
      } else emptyList()
    // The error belonged to the attempt being retried, and every pending call
    // is settled by this turn — the server denies whatever it left out.
    chat = chat.copy(messages = history + authored, error = null, pending = emptyList())
    phase = Phase.Submitted
    publish()

    var payload =
      jsonObjectOf("turn" to turn.json, "clientRunId" to JsonPrimitive(clientRunId))
        .with("threadId", chat.threadId.json())
        .with("messages", if (chat.threadId == null) JsonArray(forWire(history).map { it.json }) else null)
    body.forEach { (key, value) -> payload = payload.with(key, value) }

    val id = Any()
    // Lazy, so `inFlight` names the job before any of it runs: on an immediate
    // dispatcher — `viewModelScope`'s — a turn that never suspends is over
    // inside `launch`, and its `finish` would find nothing to finish.
    val job =
      scope.launch(start = CoroutineStart.LAZY) {
        try {
          val response = post("", payload)
          try {
            if (!response.isSuccess) {
              fail(httpError(response))
              return@launch
            }
            consume(response)
          } finally {
            response.close()
          }
        } catch (error: CancellationException) {
          // `stop()`, a superseding send, or `close()`: each has already put
          // the UI where it belongs.
          throw error
        } catch (error: Exception) {
          fail(AgentError(code = "unknown", message = error.message ?: error.toString(), retryable = true))
        } finally {
          finish(id)
        }
      }
    inFlight = InFlight(id, job, clientRunId)
    job.start()
    return job
  }

  private fun finish(id: Any) {
    if (inFlight?.id !== id) return
    inFlight = null
    phase = Phase.Idle
    publish()
  }

  private suspend fun consume(response: ChatResponse) {
    val decoder = SSEFrameDecoder()
    response.body.collect { chunk -> for (frame in decoder.push(chunk)) if (!apply(frame)) return@collect }
    for (frame in decoder.flush()) if (!apply(frame)) return
  }

  /** One frame into the state, and the callbacks it earns. `false` once the
   *  job is cancelled: a token landing after stop is worse than none. */
  private suspend fun apply(frame: StreamFrame): Boolean {
    if (!currentCoroutineContext().isActive) return false
    phase = Phase.Streaming
    val before = chat
    // A replayed frame changes nothing and fires nothing.
    val next = chat.apply(frame) ?: return true.also { publish() }
    chat = next
    publish()

    val event = frame.event.obj() ?: return true
    when (event.string("type")) {
      // Only for a message that was not already finished: a run replayed onto a
      // restored transcript must not have an app persist a message twice.
      "message-end" -> {
        val id = event.string("messageId")
        val message = chat.messages.firstOrNull { it.id == id }
        if (message != null && before.messages.firstOrNull { it.id == id }?.finishReason == null) onFinish?.invoke(message)
      }
      "awaiting-input" -> onAwaitingInput?.invoke(chat.pending)
      "error" -> event["error"].obj()?.let { onError?.invoke(AgentError(it)) }
    }
    return true
  }

  /** A failure reported without touching the conversation: `pending` survives,
   *  because its calls carry the only signatures that can answer it. */
  private fun fail(error: AgentError) {
    chat = chat.copy(error = error)
    publish()
    onError?.invoke(error)
  }

  // --- answering -----------------------------------------------------------

  /**
   * Approves or refuses a pending call. Answers given in one go — a loop over
   * `pending` — are sent as one turn, because a turn that leaves a call
   * unanswered refuses it. The returned job is the turn going out.
   */
  public fun approve(toolCallId: String, approve: Boolean, reason: String? = null): Job {
    val call = pendingCall(toolCallId) ?: return Job().apply { complete() }
    return queue(ClientToolResult.Approval(toolCallId, call.signature, call.path, approve, reason))
  }

  /** `approve`, for a typed pending call. */
  public fun approve(call: TypedPendingCall<*, *>, approve: Boolean, reason: String? = null): Job =
    approve(call.toolCallId, approve, reason)

  /** Answers a `question` or `client` call with its output. */
  public fun answer(toolCallId: String, output: JsonElement): Job {
    val call = pendingCall(toolCallId) ?: return Job().apply { complete() }
    return queue(ClientToolResult.Output(toolCallId, call.signature, call.path, output))
  }

  /** `answer`, with the answer's type fixed by the tool's schema. */
  public fun <Input, Output> answer(call: TypedPendingCall<Input, Output>, output: Output): Job =
    answer(call.toolCallId, GemiJson.encodeToJsonElement(call.output, output))

  private fun pendingCall(toolCallId: String): PendingToolCall? {
    val matches = chat.pending.filter { it.toolCallId == toolCallId }
    if (matches.size == 1) return matches[0]
    // No call, or two sub-runs holding calls with the same id. Refusing beats
    // guessing: picking one would approve a tool the user was not looking at.
    fail(
      AgentError(
        code = "invalid_tool_result",
        message =
          if (matches.isEmpty()) "No pending tool call $toolCallId"
          else "Ambiguous tool call $toolCallId: ${matches.size} pending calls share it",
        retryable = false,
        toolCallId = toolCallId,
      )
    )
    return null
  }

  private fun queue(result: ClientToolResult): Job {
    queued?.let { (results, flush) ->
      results.add(result)
      return flush
    }
    val results = mutableListOf(result)
    val flush =
      scope.launch {
        // After the code that queued this has returned — the same place the
        // web hook's microtask lands.
        yield()
        queued = null
        send(ClientTurn(toolResults = results))
      }
    queued = results to flush
    return flush
  }

  // --- stopping ------------------------------------------------------------

  /**
   * Cancels the turn. The UI stops now — the interrupted message stays, marked
   * aborted — and the server is told, which is what actually ends the
   * generation and any tool mid-flight.
   */
  public suspend fun stop() {
    val runId = chat.runId
    val threadId = chat.threadId
    val current = inFlight
    current?.job?.cancel()
    inFlight = null
    chat = chat.markAborted()
    phase = Phase.Idle
    publish()
    // Gated on the request, not on `runId`: the seconds before `run-start` are
    // the ones a user is most likely to cancel in.
    if (current == null && runId == null) return
    postStop(
      jsonObjectOf("runId" to runId.json(), "threadId" to threadId.json(), "clientRunId" to current?.clientRunId.json()),
      ::fail,
    )
  }

  /**
   * Drops the stream without stopping the run — what the web hook does on
   * unmount. The run keeps going on the server, and a session made later on
   * the same thread attaches to it. `stop()` is the one that ends the run.
   */
  public fun close() {
    inFlight?.job?.cancel()
    inFlight = null
    phase = Phase.Idle
    publish()
  }

  private suspend fun postStop(stopBody: JsonObject, report: (AgentError) -> Unit) {
    try {
      val response = post("/stop", stopBody)
      // Closed either way: a stop that worked has a body nobody reads.
      try {
        if (!response.isSuccess) report(httpError(response))
      } finally {
        response.close()
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      report(AgentError(code = "unknown", message = error.message ?: error.toString(), retryable = true))
    }
  }

  // --- the rest ------------------------------------------------------------

  /** Drops the last assistant turn and re-runs from the user turn before it. */
  public suspend fun regenerate() {
    val messages = chat.messages
    val assistant = messages.indexOfLast { it.role == AgentMessage.Role.Assistant }
    if (assistant == -1) return
    val user = messages.subList(0, assistant).indexOfLast { it.role == AgentMessage.Role.User }
    if (user == -1) return
    val turn = turnFrom(messages[user])
    // The user turn goes too, because `send` re-appends it.
    chat = chat.copy(messages = messages.subList(0, user), pending = emptyList(), error = null)
    publish()
    send(turn)
  }

  /** Replaces the transcript, e.g. with a thread re-read after `onAttachMiss`. */
  public fun setMessages(messages: List<AgentMessage>) {
    chat = chat.copy(messages = messages)
    publish()
  }

  /** Uploads through the agent's own `/files` route. Put `upload.file` in a
   *  turn's `files` to show the model the file; `upload.attachmentId` is the
   *  handle a tool fetches it by. */
  public suspend fun upload(bytes: ByteArray, name: String, mimeType: String): ChatUpload {
    val boundary = "gemi-${UUID.randomUUID()}"
    // Escaped as a browser's `FormData` does: a quote or a line break in a
    // name would otherwise end the header, and could start another.
    val filename = name.replace("\"", "%22").replace("\r", "%0D").replace("\n", "%0A")
    val form =
      "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$filename\"\r\nContent-Type: $mimeType\r\n\r\n".toByteArray() +
        bytes +
        "\r\n--$boundary--\r\n".toByteArray()
    val response = transport.send(ChatRequest("$endpoint/files", headers(), form, "multipart/form-data; boundary=$boundary"))
    val result =
      try {
        if (!response.isSuccess) {
          val error = httpError(response)
          fail(error)
          throw AgentException(error)
        }
        runCatching { GemiJson.parseToJsonElement(response.bytes().decodeToString()).obj() }.getOrNull()
      } finally {
        response.close()
      }
    // Both ids passed through as they came, and neither required: which one a
    // file has is the server's policy. The name and type are already here.
    return ChatUpload(
      fileId = result?.string("fileId"),
      attachmentId = result?.string("attachmentId"),
      name = result?.string("name") ?: name,
      mimeType = result?.string("mimeType") ?: mimeType,
      downgraded = result?.string("downgraded"),
    )
  }

  /** Asks whether a run is still going on the thread and picks it up from the
   *  cursor. Done by the constructor when `attach` is on. */
  private fun attachToRun(threadId: String) {
    val attachBody = jsonObjectOf("threadId" to JsonPrimitive(threadId), "cursor" to JsonPrimitive(chat.seq), "runId" to chat.cursorRunId.json())
    val id = Any()
    // Lazy for the reason `start`'s is.
    val job =
      scope.launch(start = CoroutineStart.LAZY) {
        try {
          val response = post("/attach", attachBody)
          try {
            // Nothing running is the ordinary answer, and on more than one
            // instance also what a refresh routed away from its run gets.
            if (!response.isSuccess || response.statusCode == 204) {
              onAttachMiss?.invoke(threadId)
              return@launch
            }
            consume(response)
          } finally {
            response.close()
          }
        } catch (error: CancellationException) {
          throw error
        } catch (_: Exception) {
          // A probe that could not be made leaves the session where one
          // without `attach` would be.
        } finally {
          finish(id)
        }
      }
    // No `clientRunId`: this client did not start the run.
    inFlight = InFlight(id, job, null)
    job.start()
  }

  private suspend fun post(path: String, payload: JsonObject): ChatResponse =
    transport.send(
      ChatRequest(
        url = endpoint + path,
        headers = headers() + ("Accept" to "text/event-stream"),
        body = GemiJson.encodeToString(JsonObject.serializer(), payload).toByteArray(),
        contentType = "application/json",
      )
    )
}

// --- helpers ---------------------------------------------------------------

/** Ids this client mints. Prefixed so they cannot collide with the server's. */
internal fun localId(): String = "local_${UUID.randomUUID()}"

/** An HTTP failure before the stream started, in the stream's error shape. */
internal suspend fun httpError(response: ChatResponse): AgentError {
  var message = "Request failed with status ${response.statusCode}"
  var code = if (response.statusCode == 429) "rate_limited" else "unknown"
  runCatching { GemiJson.parseToJsonElement(response.bytes().decodeToString()).obj() }.getOrNull()?.let { json ->
    message = json["error"].obj()?.string("message") ?: json.string("message") ?: message
    // The one server code an app can act on: the thread it holds is gone.
    if (json["error"].obj()?.string("code") == "thread_not_found" || json.string("code") == "thread_not_found") {
      code = "thread_not_found"
    }
  }
  return AgentError(code = code, message = message, retryable = response.statusCode == 429 || response.statusCode >= 500)
}

internal fun turnFrom(message: AgentMessage): ClientTurn {
  val text = StringBuilder()
  val files = mutableListOf<ChatFile>()
  for (part in message.content) {
    when (part) {
      is ContentPart.Text -> text.append(part.text)
      is ContentPart.File -> files.add(ChatFile(part.fileId, part.name, part.mimeType))
      else -> {}
    }
  }
  return ClientTurn(text = text.toString().ifEmpty { null }, files = files)
}

/** The history as the server needs it: without `progress`, which nothing
 *  server-side reads and which a stateless client would otherwise upload on
 *  every turn. `nested` is kept, recursed into, because the resume path
 *  replays a sub-agent from it. */
internal fun forWire(messages: List<AgentMessage>): List<AgentMessage> =
  messages.map { message ->
    val content = message.json["content"].array() ?: return@map message
    val touched = content.any { it.obj()?.string("type") == "tool-call" && (it.obj()?.get("progress") != null || it.obj()?.get("nested") != null) }
    if (!touched) return@map message
    AgentMessage(
      message.json.with(
        "content",
        JsonArray(
          content.map { value ->
            val part = value.obj()
            if (part == null || part.string("type") != "tool-call") return@map value
            var stripped = part.with("progress", null)
            part["nested"].array()?.let { runs ->
              stripped =
                stripped.with(
                  "nested",
                  JsonArray(
                    runs.map { run ->
                      val obj = run.obj() ?: return@map run
                      val inner = obj["messages"].array().orEmpty().map { AgentMessage(it.obj() ?: JsonObject(emptyMap())) }
                      obj.with("messages", JsonArray(forWire(inner).map { it.json }))
                    }
                  ),
                )
            }
            stripped
          }
        ),
      )
    )
  }
