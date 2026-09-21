package dev.gemijs.chat.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import dev.gemijs.chat.AgentMessage
import dev.gemijs.chat.ChatCursor
import dev.gemijs.chat.ChatSession
import dev.gemijs.chat.ChatTransport
import dev.gemijs.chat.ChatUiState
import dev.gemijs.chat.OkHttpTransport
import kotlinx.serialization.json.JsonObject

/**
 * A `ChatSession` that lives as long as the composable calling this does —
 * the closest thing Compose has to `useChat`.
 *
 *     val chat = rememberChat("https://example.com/api/support", threadId = threadId)
 *     val state by chat.collectState()
 *     LazyColumn { items(state.messages) { MessageRow(it) } }
 *     Button(onClick = { scope.launch { chat.send(text) } }) { Text("Send") }
 *
 * Leaving the composition drops the stream without stopping the run, as a
 * React unmount does; a session remembered again on the same thread attaches
 * to it. A new `endpoint` or `threadId` is a new session.
 *
 * A session here does not survive a configuration change. For one that does,
 * construct `ChatSession` in a `ViewModel` with `viewModelScope` — it is the
 * same class — and read `state` with `collectAsState()`.
 */
@Composable
public fun rememberChat(
  endpoint: String,
  threadId: String? = null,
  initialMessages: List<AgentMessage> = emptyList(),
  cursor: ChatCursor? = null,
  attach: Boolean = true,
  headers: suspend () -> Map<String, String> = { emptyMap() },
  body: JsonObject = JsonObject(emptyMap()),
  transport: ChatTransport? = null,
): ChatSession {
  val scope = rememberCoroutineScope()
  val session =
    remember(endpoint, threadId) {
      ChatSession(
        endpoint = endpoint,
        scope = scope,
        threadId = threadId,
        initialMessages = initialMessages,
        cursor = cursor,
        attach = attach,
        headers = headers,
        body = body,
        transport = transport ?: OkHttpTransport(),
      )
    }
  // The latest lambdas, so a token provider that closes over state is current
  // — handed over once the composition commits, not while it may be discarded.
  SideEffect {
    session.headers = headers
    session.body = body
  }
  DisposableEffect(session) { onDispose { session.close() } }
  return session
}

/** `state`, as Compose `State`. */
@Composable
public fun ChatSession.collectState(): State<ChatUiState> = state.collectAsState()
