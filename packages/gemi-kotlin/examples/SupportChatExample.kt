// A support chat screen built on gemi-chat, showing the library end to end.
//
// It is written against `SupportAgent` and `Classifier`, the files
// `gemi ai:generate-client` wrote for the fixture agents in
// `packages/gemi/bin/ai-client/__fixtures__/support.ts` — in an app they are
// whatever you generated for your own agents:
//
//   gemi ai:generate-client app/agents/support.ts#supportAgent \
//     --out android/app/src/main/kotlin/com/example/agents \
//     --platform kotlin --package com.example.agents
//
// Besides gemi-chat it uses Compose Material 3, `lifecycle-viewmodel-compose`
// and `activity-compose`, as most Android apps already do.
//
// Sections:
//   1. Creating a session: endpoint, auth headers, threads, restoring
//   2. Persisting a conversation: messages + cursor, together
//   3. Rendering a transcript: every ContentPart case
//   4. Typed tool calls: inputs, progress (a discriminated union), sub-agents
//   5. Typed tool results: Outcome and a union output
//   6. Pending calls: approvals and typed answers
//   7. Status, errors, stop, regenerate
//   8. Uploads: the two ids
//   9. Structured output
//  10. The untyped session, for an agent you did not generate for

package com.example.support

import android.net.Uri
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.agents.Classifier
import com.example.agents.SupportAgent
import dev.gemijs.chat.AgentException
import dev.gemijs.chat.AgentMessage
import dev.gemijs.chat.ChatCursor
import dev.gemijs.chat.ChatFile
import dev.gemijs.chat.ChatSession
import dev.gemijs.chat.ChatStatus
import dev.gemijs.chat.ChatUiState
import dev.gemijs.chat.ClientTurn
import dev.gemijs.chat.ContentPart
import dev.gemijs.chat.FinishReason
import dev.gemijs.chat.NestedRun
import dev.gemijs.chat.PendingToolCall
import dev.gemijs.chat.TypedToolResult.Outcome
import dev.gemijs.chat.compose.collectState
import dev.gemijs.chat.compose.rememberChat
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private const val TAG = "SupportChat"

// region 1. Creating a session

/** Where the access token comes from. `headers` is a suspend lambda asked
 *  before every request, so a refreshed token is picked up on the next one. */
object Tokens {
  suspend fun current(): String = "token"
}

/**
 * The session lives in a `ViewModel`, so the conversation survives a rotation.
 * `ChatSession` is confined to the thread its scope dispatches to;
 * `viewModelScope` is the main thread, which is where Compose calls it from.
 */
class SupportChatViewModel(saved: SavedConversation? = null) : ViewModel() {
  val chat =
    ChatSession(
      // The agent's route as mounted: `"/support": this.agent(SupportController)`
      // in an ApiRouter is served at `/api/support`.
      endpoint = "https://example.com/api/support",
      scope = viewModelScope,
      // With a thread the server keeps the history; without one the session
      // keeps it and posts it with every turn (stateless).
      threadId = saved?.threadId,
      initialMessages = saved?.messages.orEmpty(),
      // Restored beside the messages, so attaching to a run that is still
      // going asks only for the frames this client has not seen.
      cursor = saved?.cursor,
      // On a thread, pick up a run that is still streaming — the app was
      // killed mid-answer, say. Defaults to true.
      attach = true,
      headers = { mapOf("Authorization" to "Bearer ${Tokens.current()}") },
      // Merged into every request body, for whatever your controller reads
      // off the request besides the message.
      body = buildJsonObject { put("locale", "tr") },
    )

  init {
    // Callbacks. Each fires once per event, never again for a replayed frame.
    chat.onFinish = { message -> Log.d(TAG, "assistant finished ${message.id}: ${message.finishReason?.value}") }
    chat.onError = { error -> Log.w(TAG, "agent error ${error.code}: ${error.message} retryable=${error.retryable}") }
    chat.onAwaitingInput = { pending -> Log.d(TAG, "the agent is waiting on ${pending.size} call(s)") }
    chat.onAttachMiss = { threadId ->
      // No run found for the thread. Behind a load balancer the run may be
      // alive on another instance: re-read the thread from your own route and
      // hand the messages over with `chat.setMessages(...)`.
      Log.d(TAG, "nothing to attach to on $threadId")
    }
  }

  // The session's calls that suspend, launched where the session lives.
  fun send(turn: ClientTurn) = viewModelScope.launch { chat.send(turn) }

  fun stop() = viewModelScope.launch { chat.stop() }

  fun regenerate() = viewModelScope.launch { chat.regenerate() }

  // `close()` drops the stream without stopping the run — the server finishes
  // it, and a session made later on the thread attaches to it. `stop()` is the
  // one that ends the run.
  override fun onCleared() = chat.close()
}

// endregion

// region 2. Persisting a conversation

/**
 * What to save when the screen goes away. An `AgentMessage` holds exactly the
 * JSON the server sent — the fields this client does not model included — so a
 * restored stateless conversation posts back what the server expects.
 */
data class SavedConversation(val threadId: String?, val messages: List<AgentMessage>, val cursor: ChatCursor) {
  fun toJson(): JsonObject = buildJsonObject {
    threadId?.let { put("threadId", it) }
    put("messages", JsonArray(messages.map { it.json }))
    cursor.runId?.let { put("runId", it) }
    put("seq", cursor.seq)
  }

  companion object {
    fun of(state: ChatUiState) = SavedConversation(state.threadId, state.messages, state.cursor)

    fun fromJson(json: JsonObject) =
      SavedConversation(
        threadId = json["threadId"]?.jsonPrimitive?.contentOrNull,
        messages = json["messages"]!!.jsonArray.map { AgentMessage(it.jsonObject) },
        cursor = ChatCursor(json["runId"]?.jsonPrimitive?.contentOrNull, json["seq"]!!.jsonPrimitive.int),
      )
  }
}

// endregion

// region The screen

@Composable
fun SupportChatScreen(model: SupportChatViewModel = viewModel()) {
  // One value holding everything the screen renders.
  val state by model.chat.collectState()
  var draft by remember { mutableStateOf("") }
  val attached = remember { mutableStateListOf<ChatFile>() }
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  // region 8. Uploads

  suspend fun upload(uri: Uri) {
    val resolver = context.contentResolver
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return
    val mimeType = resolver.getType(uri) ?: "application/octet-stream"
    val name = uri.lastPathSegment ?: "file"
    try {
      val upload = model.chat.upload(bytes, name, mimeType)
      // Two ids, either of which can be missing:
      //  - `fileId` is the provider's. `upload.file` is the ChatFile to put in
      //    a turn so the model sees it — null when the server kept the file
      //    without sending it to the provider.
      //  - `attachmentId` is gemi's: the handle a tool fetches the bytes by.
      //    Tell the agent about it in your own words or payload.
      upload.file?.let(attached::add)
      upload.attachmentId?.let { draft += " (attachment $it)" }
      if (upload.downgraded == "no_scope") {
        // The server wanted to keep the file but could not tell whose it is:
        // a route missing its auth middleware, not the app's policy.
        Log.w(TAG, "upload was not kept: the route has no attachment scope")
      }
    } catch (e: AgentException) {
      // Also reported through `state.error` and `onError`.
      Log.w(TAG, "upload failed: ${e.error.message}")
    }
  }

  // endregion

  val picker =
    rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
      if (uri != null) scope.launch { upload(uri) }
    }

  Column(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.weight(1f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      items(state.messages, key = { it.id }) { message -> MessageView(message) }
      if (state.loadedTools.isNotEmpty()) {
        // Deferred tools the model pulled in this run: somewhere to say what
        // it is doing instead of an unexplained pause.
        item { Caption("Looking at ${state.loadedTools.joinToString()}…") }
      }
    }
    PendingCallsView(state, model.chat)
    StatusBar(state, onStop = model::stop, onRegenerate = model::regenerate)
    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
      TextButton(onClick = { picker.launch("*/*") }) { Text("Attach") }
      TextField(draft, { draft = it }, Modifier.weight(1f), placeholder = { Text("Message") })
      Button(
        onClick = {
          // A turn is text, files, answers to pending calls, or any mix.
          model.send(ClientTurn(text = draft.ifEmpty { null }, files = attached.toList()))
          draft = ""
          attached.clear()
        },
        enabled = draft.isNotEmpty() || attached.isNotEmpty(),
      ) {
        Text("Send")
      }
    }
  }
}

@Composable
private fun Caption(text: String, modifier: Modifier = Modifier) =
  Text(text, modifier, style = MaterialTheme.typography.labelSmall)

// endregion

// region 3. Rendering a transcript

@Composable
fun MessageView(message: AgentMessage) {
  val mine = message.role == AgentMessage.Role.User
  Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
    message.content.forEach { PartView(it) }
    if (message.role == AgentMessage.Role.Assistant && message.finishReason == null) {
      CircularProgressIndicator(Modifier.padding(4.dp)) // still streaming
    }
    if (message.finishReason == FinishReason.Aborted) Caption("Stopped")
    message.usage?.let { Caption("${it.totalTokens} tokens") }
  }
}

/** `ContentPart` is the transcript's own vocabulary, the same union `useChat`
 *  renders. Tool parts are read typed through the generated schema. */
@Composable
fun PartView(part: ContentPart) {
  when (part) {
    is ContentPart.Text -> Text(part.text)

    // Rendered separately, or not at all — it is not the answer.
    is ContentPart.Reasoning -> part.text?.let { Text(it, fontStyle = FontStyle.Italic) }

    is ContentPart.File -> Text("📄 ${part.name ?: part.fileId}")

    is ContentPart.ToolCall -> ToolCallView(SupportAgent.toolCall(part))

    is ContentPart.ToolResult -> ToolResultView(SupportAgent.toolResult(part))

    // Only on an agent with an `output` schema — see section 9.
    is ContentPart.Output -> Text(if (part.partial) "Composing an answer…" else "Answer ready")

    // A part type from a newer server. Nothing to show, nothing broken.
    is ContentPart.Unknown -> Unit
  }
}

// endregion

// region 4. Typed tool calls

@Composable
fun ToolCallView(call: SupportAgent.ToolCall) {
  when (call) {
    is SupportAgent.ToolCall.Grep -> {
      // `input` is null while the model is still streaming the arguments.
      val input = call.value.input
      Text(if (input != null) "Searching ${input.filePath} for /${input.pattern}/" else "Deciding what to search…")
    }

    is SupportAgent.ToolCall.Bash -> Column {
      Text("$ ${call.value.input?.command ?: "…"}", fontFamily = FontFamily.Monospace)
      // `progress` is what the tool's generator yielded, typed by the
      // generator: here a union told apart by its `stage` field.
      call.value.progress.forEach { entry ->
        when (entry) {
          is SupportAgent.BashProgressStarted -> Caption("started, pid ${entry.pid.toInt()}")
          is SupportAgent.BashProgressLine ->
            Text(
              entry.text,
              fontFamily = FontFamily.Monospace,
              color =
                if (entry.stream == SupportAgent.BashProgressLineStream.Stderr) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurface,
            )
        }
      }
    }

    is SupportAgent.ToolCall.Charge ->
      call.value.input?.let { input ->
        // `currency` is an enum with the wire values; `metadata` is optional
        // (absent), `reason` is nullable (present, may be null).
        Column {
          Text("Charge ${input.amountCents / 100} ${input.currency.name.uppercase()}")
          input.reason?.let { Caption(it) }
          input.metadata?.lineItems?.forEach { Caption("${it.qty.toInt()}× ${it.sku}") }
        }
      }

    // `refund_order` on the wire, `RefundOrder` in Kotlin.
    is SupportAgent.ToolCall.RefundOrder -> Text("Refunding ${call.value.input?.orderId ?: "…"}")

    is SupportAgent.ToolCall.Stats,
    is SupportAgent.ToolCall.Ping -> Text("Checking…")

    // Answered from the pending list — section 6.
    is SupportAgent.ToolCall.Ask -> Unit

    // A tool added since this file was generated, or a skill.
    is SupportAgent.ToolCall.Unknown -> Text("🔧 ${call.value.name}")
  }

  // Sub-agent runs a tool drove. Their messages are an ordinary transcript, so
  // they render with the same views — untyped, because a sub-agent's tools are
  // its own.
  nested(call).forEach { run ->
    Column(Modifier.padding(start = 16.dp)) {
      Caption(run.label ?: run.agent)
      run.messages.forEach { MessageView(it) }
    }
  }
}

private fun nested(call: SupportAgent.ToolCall): List<NestedRun> =
  when (call) {
    is SupportAgent.ToolCall.Grep -> call.value.nested
    is SupportAgent.ToolCall.Bash -> call.value.nested
    is SupportAgent.ToolCall.Charge -> call.value.nested
    is SupportAgent.ToolCall.Stats -> call.value.nested
    is SupportAgent.ToolCall.Ping -> call.value.nested
    is SupportAgent.ToolCall.Ask -> call.value.nested
    is SupportAgent.ToolCall.RefundOrder -> call.value.nested
    is SupportAgent.ToolCall.Unknown -> call.value.nested
  }

// endregion

// region 5. Typed tool results

@Composable
fun ToolResultView(result: SupportAgent.ToolResult) {
  when (result) {
    is SupportAgent.ToolResult.Charge ->
      when (val outcome = result.value.outcome) {
        is Outcome.Ok ->
          // The output is itself a union, told apart by `status`.
          when (val output = outcome.output) {
            is SupportAgent.ChargeOutputPaid -> Text("✓ Paid — receipt ${output.receiptId}")
            is SupportAgent.ChargeOutputDeclined ->
              Text("✗ Declined (${output.declineCode})${if (output.retryable) ", try again" else ""}")
          }
        is Outcome.Error -> Text("Failed: ${outcome.error.message}", color = MaterialTheme.colorScheme.error)
        // "refused" when the user said no, "stopped" when a stop landed first.
        is Outcome.Denied -> Text("Not charged (${outcome.cause})${outcome.reason?.let { ": $it" } ?: ""}")
      }

    is SupportAgent.ToolResult.Grep ->
      (result.value.outcome as? Outcome.Ok)?.let { Caption("${it.output.matches.size} match(es)") }

    is SupportAgent.ToolResult.Bash ->
      (result.value.outcome as? Outcome.Ok)?.output?.takeIf { it.exitCode != 0.0 }?.let {
        Caption("exited ${it.exitCode.toInt()}", Modifier)
      }

    is SupportAgent.ToolResult.Stats ->
      // `Record<string, number>` is a map.
      (result.value.outcome as? Outcome.Ok)?.output?.counts?.toSortedMap()?.forEach { (label, count) ->
        Caption("$label: ${count.toInt()}")
      }

    // No schema and an `unknown` return: raw JSON, as sent.
    is SupportAgent.ToolResult.Ping -> (result.value.outcome as? Outcome.Ok)?.let { Caption(it.output.toString()) }

    is SupportAgent.ToolResult.RefundOrder ->
      (result.value.outcome as? Outcome.Ok)?.output?.let {
        Caption("Refund ${it.refundId}${if (it.default) " (default)" else ""}")
      }

    is SupportAgent.ToolResult.Ask -> Unit

    // Includes a known tool whose output no longer decodes: the raw part is
    // still in the transcript, nothing throws.
    is SupportAgent.ToolResult.Unknown -> Unit
  }
}

// endregion

// region 6. Pending calls

@Composable
fun PendingCallsView(state: ChatUiState, chat: ChatSession) {
  // Non-empty exactly when `status == AwaitingInput`.
  if (state.pending.isEmpty()) return
  var answer by remember { mutableStateOf("") }
  Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      state.pending.map(SupportAgent::pending).forEach { pending ->
        when (pending) {
          // An approval: the server runs the tool once someone says yes.
          is SupportAgent.Pending.Charge -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Charge ${(pending.value.input?.amountCents ?: 0.0) / 100}?", Modifier.weight(1f))
            Button(onClick = { chat.approve(pending.value, true) }) { Text("Approve") }
            OutlinedButton(onClick = { chat.approve(pending.value, false, reason = "The customer declined") }) {
              Text("Decline")
            }
          }

          // A question: the answer's type is the tool's output schema, so a
          // wrong-shaped answer does not compile.
          is SupportAgent.Pending.Ask -> Column {
            Text(pending.value.input?.question.orEmpty())
            TextField(answer, { answer = it }, placeholder = { Text("Your answer") })
            Button(onClick = { chat.answer(pending.value, SupportAgent.AskOutput(answer = answer)) }) {
              Text("Answer")
            }
          }

          // Any other pending call, typed or not, answered by id.
          else -> {
            val raw = state.pending.firstOrNull { it.kind == PendingToolCall.Kind.Approval }
            if (raw != null) Button(onClick = { chat.approve(raw.toolCallId, true) }) { Text("Approve ${raw.name}") }
          }
        }
      }
      // Approving everything at once: answers given in one go are sent as ONE
      // turn. Sent one by one, the first turn would refuse the others.
      if (state.pending.size > 1) {
        Button(onClick = {
          state.pending.filter { it.kind == PendingToolCall.Kind.Approval }.forEach { chat.approve(it.toolCallId, true) }
        }) {
          Text("Approve all")
        }
      }
      // A question a sub-agent asked arrives here too; `path` says whose it
      // is, and answering it is no different.
      state.pending.filter { it.path != null }.forEach { Caption("${it.name} is asked by a sub-agent") }
    }
  }
}

// endregion

// region 7. Status, errors, stop, regenerate

@Composable
fun StatusBar(state: ChatUiState, onStop: () -> Unit, onRegenerate: () -> Unit) {
  Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
    val label =
      when (state.status) {
        ChatStatus.Idle -> "Ready"
        ChatStatus.Submitted -> "Sending…"
        ChatStatus.Streaming -> "Answering…"
        ChatStatus.AwaitingInput -> "Waiting for you"
        ChatStatus.Error -> state.error?.message ?: "Something went wrong"
      }
    Caption(label, Modifier.weight(1f))
    when {
      // Marks the turn aborted at once, then tells the server, which ends the
      // generation and any tool mid-flight.
      state.status == ChatStatus.Submitted || state.status == ChatStatus.Streaming ->
        TextButton(onClick = onStop) { Text("Stop") }
      // The thread is gone: start a new one, or carry on stateless.
      state.status == ChatStatus.Error && state.error?.code == "thread_not_found" ->
        Caption("This conversation expired")
      state.status == ChatStatus.Error && state.error?.retryable == true ->
        TextButton(onClick = onRegenerate) { Text("Retry") }
      state.status == ChatStatus.Idle && state.messages.lastOrNull()?.role == AgentMessage.Role.Assistant ->
        TextButton(onClick = onRegenerate) { Text("Regenerate") }
    }
  }
}

// endregion

// region 9. Structured output

/**
 * An agent with an `output` schema answers with an object. Its `output` part
 * streams as partial snapshots; the typed value is there once it parses.
 *
 * A one-shot session outside any screen: `coroutineScope` is its scope, and
 * `send` returns once the turn has finished.
 */
suspend fun classify(text: String): Classifier.StructuredOutput? = coroutineScope {
  val chat = ChatSession("https://example.com/api/classify", scope = this)
  chat.send(text)
  val message = chat.state.value.messages.lastOrNull { it.role == AgentMessage.Role.Assistant }
  val part = message?.content?.filterIsInstance<ContentPart.Output>()?.lastOrNull()
  chat.close()
  val result = part?.let(Classifier::output) ?: return@coroutineScope null
  // `sentiment` is an enum: `Positive`, `Neutral`, `Negative`.
  Log.d(TAG, "${result.sentiment} about ${result.topics.joinToString()}")
  result
}

// endregion

// region 10. The untyped session

/**
 * For an agent nothing was generated for — no schema at all. Every part is
 * read raw, and payloads are `JsonElement`: still the whole library, just not
 * typed. The Compose way to make a session, for a screen that need not survive
 * a configuration change, is `rememberChat`.
 */
@Composable
fun UntypedChatScreen(threadId: String?) {
  val chat = rememberChat("https://example.com/api/other", threadId = threadId)
  val state by chat.collectState()
  val scope = rememberCoroutineScope()

  Column {
    Button(onClick = { scope.launch { chat.send("hello") } }) { Text("Say hello") }
    state.messages.flatMap { it.content }.filterIsInstance<ContentPart.ToolCall>().forEach { call ->
      val query = (call.input as? JsonObject)?.get("query")?.jsonPrimitive?.contentOrNull
      Text("${call.name}: ${query ?: "-"}")
    }
    state.pending.firstOrNull { it.kind == PendingToolCall.Kind.Question }?.let { call ->
      // Any `JsonElement` answers an untyped question.
      Button(onClick = { chat.answer(call.toolCallId, buildJsonObject { put("answer", "yes") }) }) {
        Text("Answer ${call.name}")
      }
    }
  }
}

// endregion
