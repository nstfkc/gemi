package dev.gemijs.chat

import dev.gemijs.chat.generated.E2eAgent
import java.util.concurrent.Executors
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.jupiter.api.Assumptions.assumeTrue

// `ChatSession` against a real `AgentController` (packages/gemi-swift/e2e/
// server.ts, which the Swift client's end-to-end tests use too). Skipped
// unless `GEMI_E2E_URL` names a running one:
//
//   bun packages/gemi-swift/e2e/server.ts 47123 &
//   GEMI_E2E_URL=http://127.0.0.1:47123 ./gradlew :gemi-chat:test
//
// What these catch that the scripted-transport tests cannot is disagreement
// with the server itself, over a real OkHttp connection.

private val server = System.getenv("GEMI_E2E_URL").orEmpty()

class EndToEndTest {
  private val support get() = "$server/api/support"

  /** One thread, as the main one would be on Android. */
  private fun e2e(block: suspend CoroutineScope.(CoroutineScope) -> Unit) {
    assumeTrue(server.isNotEmpty(), "set GEMI_E2E_URL to a running e2e/server.ts")
    val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    val scope = CoroutineScope(SupervisorJob() + dispatcher)
    try {
      runBlocking(dispatcher) { block(scope) }
    } finally {
      scope.cancel()
      dispatcher.close()
    }
  }

  private suspend fun eventually(condition: () -> Boolean) {
    repeat(1000) {
      if (condition()) return
      delay(5)
    }
    fail("condition never held")
  }

  private fun newThread(): String {
    val response =
      OkHttpClient().newCall(Request.Builder().url("$support/threads").post(ByteArray(0).toRequestBody()).build()).execute()
    return GemiJson.parseToJsonElement(response.body.string()).obj()!!.string("threadId")!!
  }

  @Test
  fun aStatelessConversationKeepsItsOwnHistory() = e2e { scope ->
    val chat = ChatSession(support, scope)
    chat.send("hello")
    assertNull(chat.state.value.error)
    assertEquals(listOf("hello", "Hello from gemi."), chat.state.value.messages.map { it.text })
    assertEquals(15, chat.state.value.messages[1].usage?.totalTokens)

    // The second turn carries the first in `messages`, and the server takes it.
    chat.send("hello again")
    assertNull(chat.state.value.error)
    assertEquals(4, chat.state.value.messages.size)
  }

  @Test
  fun anApprovalRoundTripsItsSignature() = e2e { scope ->
    val chat = ChatSession(support, scope)
    chat.send("charge")
    assertEquals(ChatStatus.AwaitingInput, chat.state.value.status)
    val call = assertIs<E2eAgent.Pending.Charge>(E2eAgent.pending(chat.state.value.pending[0])).value
    assertEquals(500.0, call.input?.amountCents)

    chat.approve(call, true).join()

    assertNull(chat.state.value.error)
    assertEquals(ChatStatus.Idle, chat.state.value.status)
    val result =
      chat.state.value.messages
        .flatMap { it.content }
        .filterIsInstance<ContentPart.ToolResult>()
        .map(E2eAgent::toolResult)
        .first()
    assertEquals(
      TypedToolResult.Outcome.Ok(E2eAgent.ChargeOutput(receiptId = "rc_500")),
      assertIs<E2eAgent.ToolResult.Charge>(result).value.outcome,
    )
  }

  @Test
  fun aRefusalReachesTheModelAsDenied() = e2e { scope ->
    val chat = ChatSession(support, scope)
    chat.send("charge")
    chat.approve(chat.state.value.pending[0].toolCallId, false, "too much").join()

    assertNull(chat.state.value.error)
    val result = chat.state.value.messages.flatMap { it.content }.filterIsInstance<ContentPart.ToolResult>().first()
    assertEquals(ContentPart.ToolResult.Outcome.Denied("refused", "too much"), result.outcome)
  }

  @Test
  fun aQuestionIsAnsweredWithTheToolsOwnType() = e2e { scope ->
    val chat = ChatSession(support, scope)
    chat.send("ask")
    val call = assertIs<E2eAgent.Pending.Ask>(E2eAgent.pending(chat.state.value.pending[0])).value
    assertEquals("Which order?", call.input?.question)

    chat.answer(call, E2eAgent.AskOutput(answer = "The March one")).join()

    assertNull(chat.state.value.error)
    assertTrue(chat.state.value.messages.last().text.contains("The March one"))
  }

  @Test
  fun progressArrivesTypedOnTheToolCall() = e2e { scope ->
    val chat = ChatSession(support, scope)
    chat.send("count")
    val part = chat.state.value.messages.flatMap { it.content }.filterIsInstance<ContentPart.ToolCall>().first()
    val call = assertIs<E2eAgent.ToolCall.Count>(E2eAgent.toolCall(part)).value
    assertEquals(listOf(1.0, 2.0, 3.0).map { E2eAgent.CountProgress(n = it) }, call.progress)
  }

  @Test
  fun aThreadedConversationIsTheServersToKeep() = e2e { scope ->
    val threadId = newThread()
    val chat = ChatSession(support, scope, threadId = threadId, attach = false)
    chat.send("hello")
    assertNull(chat.state.value.error)
    assertEquals(threadId, chat.state.value.threadId)

    // A fresh session on the same thread, restored from what the first kept.
    val restored =
      ChatSession(
        support,
        scope,
        threadId = threadId,
        initialMessages = chat.state.value.messages,
        cursor = chat.state.value.cursor,
        attach = false,
      )
    restored.send("hello")
    assertNull(restored.state.value.error)
    assertEquals(4, restored.state.value.messages.size)
  }

  @Test
  fun stopEndsTheRunOnTheServer() = e2e { scope ->
    val threadId = newThread()
    val chat = ChatSession(support, scope, threadId = threadId, attach = false)
    val sending = scope.launch { chat.send("slow") }
    eventually { chat.state.value.messages.lastOrNull()?.text?.contains("2 ") == true }

    chat.stop()
    sending.join()

    assertNull(chat.state.value.error)
    assertEquals(FinishReason.Aborted, chat.state.value.messages.last().finishReason)
    // The run is over server-side too: the thread takes a new turn.
    chat.send("hello")
    assertNull(chat.state.value.error)
    assertEquals("Hello from gemi.", chat.state.value.messages.last().text)
  }

  @Test
  fun aSessionAttachesToARunAnotherOneStarted() = e2e { scope ->
    val threadId = newThread()
    val first = ChatSession(support, scope, threadId = threadId, attach = false)
    val sending = scope.launch { first.send("slow") }
    eventually { first.state.value.messages.lastOrNull()?.text?.contains("1 ") == true }

    // The app came back mid-answer: a new session on the same thread.
    val second = ChatSession(support, scope, threadId = threadId)
    eventually { second.state.value.messages.lastOrNull()?.text?.contains("5 ") == true }
    assertEquals(ChatStatus.Streaming, second.state.value.status)

    second.stop()
    first.close()
    sending.join()
  }

  @Test
  fun anUploadReturnsTheProvidersFileId() = e2e { scope ->
    val chat = ChatSession(support, scope)
    val upload = chat.upload("%PDF".toByteArray(), "a.pdf", "application/pdf")
    assertEquals("file_a.pdf", upload.fileId)
  }
}
