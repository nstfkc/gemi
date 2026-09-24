package dev.gemijs.chat

import dev.gemijs.chat.generated.SupportAgent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// `ChatSession` against a scripted server: what it sends, and what it does
// with what comes back. The frame handling is the reducer's and is covered by
// the conformance corpus; this is the part around it — `useChat`'s.

/** Stands in for the server; every request is recorded. */
class FakeTransport(val handler: suspend (ChatRequest) -> ChatResponse) : ChatTransport {
  class Recorded(val request: ChatRequest) {
    val path: String get() = request.url.removePrefix("https://example.test")
    val body: JsonElement get() = runCatching { GemiJson.parseToJsonElement(request.body.decodeToString()) }.getOrDefault(JsonNull)
  }

  val requests = mutableListOf<Recorded>()

  override suspend fun send(request: ChatRequest): ChatResponse {
    requests += Recorded(request)
    return handler(request)
  }
}

fun jsonOf(text: String): JsonElement = GemiJson.parseToJsonElement(text)

fun frameText(seq: Int, event: String) = "id: $seq\ndata: ${jsonOf(event)}\n\n"

/** A finished SSE response carrying these events, numbered from 0. */
fun sse(vararg events: String): ChatResponse =
  ChatResponse(200, flowOf(events.mapIndexed(::frameText).joinToString("").toByteArray()))

fun jsonResponse(status: Int, body: String) = ChatResponse(status, flowOf(body.toByteArray()))

/** A response that records whether it was closed, the way a real connection
 *  goes back to the pool. */
class ClosableResponse(status: Int, body: String = "") {
  var closed = false
  val response = ChatResponse(status, flowOf(body.toByteArray())) { closed = true }
}

/** A stream the test feeds by hand and that stays open until finished. */
class OpenStream {
  private val channel = Channel<ByteArray>(Channel.UNLIMITED)
  private var seq = 0
  val response = ChatResponse(200, channel.consumeAsFlow())

  fun emit(event: String) {
    channel.trySend(frameText(seq++, event).toByteArray())
  }

  fun finish() {
    channel.close()
  }
}

const val ENDPOINT = "https://example.test/api/support"

fun answer(text: String, run: String = "run_1", message: String = "m1") =
  arrayOf(
    """{"type":"run-start","runId":"$run"}""",
    """{"type":"message-start","messageId":"$message","role":"assistant"}""",
    """{"type":"text-delta","messageId":"$message","delta":"$text"}""",
    """{"type":"message-end","messageId":"$message","finishReason":"stop"}""",
    """{"type":"run-end","runId":"$run","finishReason":"stop"}""",
  )

val JsonElement?.body: JsonObject get() = this as JsonObject

/** A scope that runs a launched body inline up to its first suspension, as
 *  `viewModelScope`'s `Dispatchers.Main.immediate` does on the main thread. */
@OptIn(ExperimentalCoroutinesApi::class)
fun TestScope.immediateScope() = CoroutineScope(UnconfinedTestDispatcher(testScheduler) + SupervisorJob())

fun TestScope.session(transport: ChatTransport, threadId: String? = null, attach: Boolean = false, body: JsonObject = JsonObject(emptyMap()), headers: suspend () -> Map<String, String> = { emptyMap() }, initialMessages: List<AgentMessage> = emptyList(), cursor: ChatCursor? = null) =
  ChatSession(ENDPOINT, backgroundScope, threadId, initialMessages, cursor, attach, headers, body, transport)

@OptIn(ExperimentalCoroutinesApi::class)
class ChatSessionTest {
  @Test
  fun aStatelessTurnPostsTheHistoryBeforeItAndStreamsTheAnswer() = runTest {
    val transport = FakeTransport { sse(*answer("Hello.")) }
    val chat = session(transport)
    val finished = mutableListOf<String>()
    chat.onFinish = { finished += it.id }

    chat.send("Hi")

    val body = transport.requests[0].body.body
    assertEquals("/api/support", transport.requests[0].path)
    assertEquals(jsonOf("""{"text":"Hi"}"""), body["turn"])
    // The turn itself is never in `messages`, or the server would see it twice.
    assertEquals(JsonArray(emptyList()), body["messages"])
    assertNull(body["threadId"])
    assertTrue(body.string("clientRunId")!!.startsWith("local_"))

    val state = chat.state.value
    assertEquals(listOf("Hi", "Hello."), state.messages.map { it.text })
    assertEquals(listOf(AgentMessage.Role.User, AgentMessage.Role.Assistant), state.messages.map { it.role })
    assertEquals(ChatStatus.Idle, state.status)
    assertEquals(listOf("m1"), finished)
    assertEquals(ChatCursor("run_1", 4), state.cursor)
  }

  @Test
  fun aThreadedTurnNamesTheThreadAndSendsNoHistory() = runTest {
    val transport = FakeTransport { sse(*answer("Hello.")) }
    val chat = session(transport, threadId = "th_1", body = jsonOf("""{"locale":"tr"}""").body)

    chat.send("Hi")

    val body = transport.requests[0].body.body
    assertEquals(JsonPrimitive("th_1"), body["threadId"])
    assertNull(body["messages"])
    assertEquals(JsonPrimitive("tr"), body["locale"])
  }

  @Test
  fun headersAreAskedForOnEveryRequest() = runTest {
    val transport = FakeTransport { sse(*answer("Hello.")) }
    var count = 0
    val chat = session(transport, headers = { mapOf("Authorization" to "Bearer ${++count}") })

    chat.send("one")
    chat.send("two")

    assertEquals(listOf("Bearer 1", "Bearer 2"), transport.requests.map { it.request.headers["Authorization"] })
  }

  @Test
  fun theHistoryGoesOutWithoutProgressLogs() = runTest {
    val transport = FakeTransport {
      sse(
        """{"type":"run-start","runId":"run_1"}""",
        """{"type":"message-start","messageId":"m1","role":"assistant"}""",
        """{"type":"tool-call","messageId":"m1","part":{"type":"tool-call","toolCallId":"tc_1","name":"bash","input":{"command":"ls"}}}""",
        """{"type":"tool-progress","toolCallId":"tc_1","data":{"stage":"started","pid":1}}""",
        """{"type":"message-end","messageId":"m1","finishReason":"stop"}""",
        """{"type":"run-end","runId":"run_1","finishReason":"stop"}""",
      )
    }
    val chat = session(transport)
    chat.send("go")
    chat.send("again")

    // The session keeps every yield; the request does not carry them.
    val part = assertIs<ContentPart.ToolCall>(chat.state.value.messages[1].content[0])
    assertEquals(1, part.progress.size)
    val posted = transport.requests[1].body.body["messages"] as JsonArray
    assertEquals(2, posted.size)
    val postedPart = (posted[1].body["content"] as JsonArray)[0].body
    assertNull(postedPart["progress"])
    assertEquals(JsonPrimitive("tc_1"), postedPart["toolCallId"])
  }

  @Test
  fun anHTTPFailureIsAnErrorInTheStreamsShape() = runTest {
    val transport = FakeTransport { jsonResponse(404, """{"error":{"code":"thread_not_found","message":"No thread th_9"}}""") }
    val chat = session(transport, threadId = "th_9")
    val reported = mutableListOf<String>()
    chat.onError = { reported += it.code }

    chat.send("Hi")

    val state = chat.state.value
    assertEquals(ChatStatus.Error, state.status)
    assertEquals("thread_not_found", state.error?.code)
    assertEquals("No thread th_9", state.error?.message)
    assertEquals(false, state.error?.retryable)
    assertEquals(listOf("thread_not_found"), reported)
  }

  @Test
  fun approvalsGivenTogetherGoOutAsOneTurn() = runTest {
    val transport = FakeTransport { request ->
      if (jsonOf(request.body.decodeToString()).body["turn"].body["toolResults"] != null) sse(*answer("Done.", "run_2", "m2"))
      else
        sse(
          """{"type":"run-start","runId":"run_1"}""",
          """{"type":"awaiting-input","runId":"run_1","pending":[
            {"toolCallId":"tc_1","name":"charge","input":{},"kind":"approval","signature":"s1"},
            {"toolCallId":"tc_2","name":"refund_order","input":{},"kind":"approval","signature":"s2","path":["tc_0"]}]}"""
            .replace("\n", ""),
          """{"type":"run-end","runId":"run_1","finishReason":"awaiting-input"}""",
        )
    }
    val chat = session(transport)
    var asked = 0
    chat.onAwaitingInput = { asked = it.size }
    chat.send("Refund it")
    assertEquals(ChatStatus.AwaitingInput, chat.state.value.status)
    assertEquals(2, asked)

    // The loop an app writes. Sent one by one, the first turn would refuse the
    // second call.
    val flushes = chat.state.value.pending.map { chat.approve(it.toolCallId, true) }
    flushes[0].join()

    assertEquals(2, transport.requests.size)
    assertTrue(
      jsonEquals(
        jsonOf(
          """{"toolResults":[
            {"toolCallId":"tc_1","signature":"s1","approve":true},
            {"toolCallId":"tc_2","signature":"s2","path":["tc_0"],"approve":true}]}"""
        ),
        transport.requests[1].body.body["turn"],
      )
    )
    assertEquals(ChatStatus.Idle, chat.state.value.status)
  }

  @Test
  fun aTypedAnswerIsEncodedByTheToolsOwnType() = runTest {
    val transport = FakeTransport { request ->
      if (jsonOf(request.body.decodeToString()).body["turn"].body["toolResults"] != null) sse(*answer("Thanks.", "run_2", "m2"))
      else
        sse(
          """{"type":"run-start","runId":"run_1"}""",
          """{"type":"awaiting-input","runId":"run_1","pending":[{"toolCallId":"tc_1","name":"ask","input":{"question":"Which order?"},"kind":"question","signature":"s1"}]}""",
          """{"type":"run-end","runId":"run_1","finishReason":"awaiting-input"}""",
        )
    }
    val chat = session(transport)
    chat.send("Refund my order")

    val call = assertIs<SupportAgent.Pending.Ask>(SupportAgent.pending(chat.state.value.pending[0])).value
    assertEquals("Which order?", call.input?.question)
    chat.answer(call, SupportAgent.AskOutput(answer = "The March one")).join()

    assertTrue(
      jsonEquals(
        jsonOf("""[{"toolCallId":"tc_1","signature":"s1","output":{"answer":"The March one"}}]"""),
        transport.requests[1].body.body["turn"].body["toolResults"],
      )
    )
  }

  @Test
  fun answeringACallTheSessionIsNotHoldingIsAnErrorNotARequest() = runTest {
    val transport = FakeTransport { sse(*answer("Hello.")) }
    val chat = session(transport)

    chat.approve("tc_nowhere", true).join()

    assertTrue(transport.requests.isEmpty())
    assertEquals("invalid_tool_result", chat.state.value.error?.code)
  }

  @Test
  fun stopMarksTheTurnAbortedAtOnceAndTellsTheServer() = runTest {
    val stream = OpenStream()
    val transport = FakeTransport { request -> if (request.url.endsWith("/stop")) jsonResponse(200, """{"stopped":true}""") else stream.response }
    val chat = session(transport, threadId = "th_1")

    val sending = launch { chat.send("Write an essay") }
    stream.emit("""{"type":"run-start","runId":"run_1"}""")
    stream.emit("""{"type":"message-start","messageId":"m1","role":"assistant"}""")
    stream.emit("""{"type":"text-delta","messageId":"m1","delta":"Once upon"}""")
    runCurrent()
    assertEquals(ChatStatus.Streaming, chat.state.value.status)

    chat.stop()
    // A token that lands after stop is not applied.
    stream.emit("""{"type":"text-delta","messageId":"m1","delta":" a time"}""")
    stream.finish()
    sending.join()

    val state = chat.state.value
    assertEquals("Once upon", state.messages[1].text)
    assertEquals(FinishReason.Aborted, state.messages[1].finishReason)
    assertEquals(ChatStatus.Idle, state.status)
    val stop = transport.requests.last()
    assertEquals("/api/support/stop", stop.path)
    assertEquals(JsonPrimitive("run_1"), stop.body.body["runId"])
    assertEquals(JsonPrimitive("th_1"), stop.body.body["threadId"])
    assertEquals(transport.requests[0].body.body["clientRunId"], stop.body.body["clientRunId"])
  }

  @Test
  fun framesAfterCloseAreNotAppliedEvenFromTheSameChunk() = runTest {
    // One chunk carrying the rest of the run. Nothing suspends between its
    // frames, so cancellation alone would let every one of them land.
    val transport = FakeTransport {
      sse(
        """{"type":"run-start","runId":"run_1"}""",
        """{"type":"message-start","messageId":"m1","role":"assistant"}""",
        """{"type":"message-end","messageId":"m1","finishReason":"stop"}""",
        """{"type":"message-start","messageId":"m2","role":"assistant"}""",
        """{"type":"text-delta","messageId":"m2","delta":"after close"}""",
      )
    }
    val chat = session(transport)
    chat.onFinish = { chat.close() }

    chat.send("Hi")

    assertEquals(listOf("user", "assistant"), chat.state.value.messages.map { it.role.value })
  }

  @Test
  fun stopBeforeTheRunHasAnIdStillNamesIt() = runTest {
    val stream = OpenStream()
    val transport = FakeTransport { request -> if (request.url.endsWith("/stop")) jsonResponse(200, """{"stopped":true}""") else stream.response }
    val chat = session(transport)

    val sending = launch { chat.send("Hi") }
    runCurrent()
    chat.stop()
    stream.finish()
    sending.join()

    // No `run-start` yet, so no runId: the client's own id is the handle.
    val stop = transport.requests.last()
    assertEquals("/api/support/stop", stop.path)
    assertEquals(JsonObject(mapOf("clientRunId" to transport.requests[0].body.body["clientRunId"]!!)), stop.body)
  }

  @Test
  fun aSecondSendCutsTheFirstAndStopsItsRun() = runTest {
    val first = OpenStream()
    val transport = FakeTransport { request ->
      when {
        request.url.endsWith("/stop") -> jsonResponse(200, """{"stopped":true}""")
        jsonOf(request.body.decodeToString()).body["turn"].body.string("text") == "first" -> first.response
        else -> sse(*answer("Second.", "run_2", "m2"))
      }
    }
    val chat = session(transport)

    val sending = launch { chat.send("first") }
    first.emit("""{"type":"run-start","runId":"run_1"}""")
    first.emit("""{"type":"message-start","messageId":"m1","role":"assistant"}""")
    first.emit("""{"type":"text-delta","messageId":"m1","delta":"Half an ans"}""")
    runCurrent()

    chat.send("second")
    first.finish()
    sending.join()
    runCurrent()

    val state = chat.state.value
    assertEquals(listOf("first", "Half an ans", "second", "Second."), state.messages.map { it.text })
    // The cut turn says it was cut; the next run's `run-end` must not relabel it.
    assertEquals(FinishReason.Aborted, state.messages[1].finishReason)
    assertEquals(FinishReason.Stop, state.messages[3].finishReason)
    val stop = transport.requests.first { it.path.endsWith("/stop") }
    assertEquals(JsonPrimitive("run_1"), stop.body.body["runId"])
    assertNull(stop.body.body["threadId"])
    val posted = transport.requests.first { (it.body.body["turn"] as? JsonObject)?.string("text") == "second" }.body.body
    assertEquals(JsonPrimitive("aborted"), (posted["messages"] as JsonArray)[1].body["finishReason"])
  }

  @Test
  fun aSessionOnAThreadAttachesToTheRunStillGoing() = runTest {
    val transport = FakeTransport {
      sse(
        """{"type":"run-start","runId":"run_1"}""",
        """{"type":"message-start","messageId":"m1","role":"assistant"}""",
        """{"type":"text-delta","messageId":"m1","delta":"already had this"}""",
        """{"type":"text-delta","messageId":"m1","delta":" and the rest"}""",
        """{"type":"message-end","messageId":"m1","finishReason":"stop"}""",
      )
    }
    val restored = AgentMessage(jsonOf("""{"id":"m1","role":"assistant","createdAt":"t","content":[{"type":"text","text":"already had this"}]}""").body)
    val chat = session(transport, threadId = "th_1", attach = true, initialMessages = listOf(restored), cursor = ChatCursor("run_1", 2))
    runCurrent()

    assertEquals("/api/support/attach", transport.requests[0].path)
    assertTrue(jsonEquals(jsonOf("""{"threadId":"th_1","cursor":2,"runId":"run_1"}"""), transport.requests[0].body))
    // Frames at or below the cursor are replay: the text is not doubled.
    assertEquals("already had this and the rest", chat.state.value.messages[0].text)
  }

  @Test
  fun anAttachMissIsReportedSoTheAppCanReReadTheThread() = runTest {
    val transport = FakeTransport { jsonResponse(404, """{"code":"no_live_run"}""") }
    val missed = mutableListOf<String>()
    val chat = session(transport, threadId = "th_1", attach = true)
    chat.onAttachMiss = { missed += it }
    runCurrent()

    assertEquals(listOf("th_1"), missed)
    assertEquals(ChatStatus.Idle, chat.state.value.status)
    assertNull(chat.state.value.error)
  }

  @Test
  fun regenerateReplacesTheLastAnswerAndAsksAgain() = runTest {
    val transport = FakeTransport { sse(*answer("Try two.", "run_2", "m2")) }
    val history =
      listOf(
        AgentMessage(jsonOf("""{"id":"u1","role":"user","createdAt":"t","content":[{"type":"text","text":"Q"}]}""").body),
        AgentMessage(jsonOf("""{"id":"m1","role":"assistant","createdAt":"t","finishReason":"stop","content":[{"type":"text","text":"Try one."}]}""").body),
      )
    val chat = session(transport, initialMessages = history)

    chat.regenerate()

    assertEquals(jsonOf("""{"text":"Q"}"""), transport.requests[0].body.body["turn"])
    assertEquals(JsonArray(emptyList()), transport.requests[0].body.body["messages"])
    assertEquals(listOf("Q", "Try two."), chat.state.value.messages.map { it.text })
  }

  @Test
  fun anUploadIsMultipartAndReturnsTheFileToSend() = runTest {
    val transport = FakeTransport { jsonResponse(200, """{"fileId":"file_1"}""") }
    val chat = session(transport)

    val upload = chat.upload("%PDF".toByteArray(), "invoice.pdf", "application/pdf")

    assertEquals(ChatFile("file_1", "invoice.pdf", "application/pdf"), upload.file)
    val request = transport.requests[0].request
    assertEquals("$ENDPOINT/files", request.url)
    assertTrue(request.contentType.startsWith("multipart/form-data; boundary="))
    val form = request.body.decodeToString()
    assertTrue(form.contains("""name="file"; filename="invoice.pdf""""))
    assertTrue(form.contains("%PDF"))
  }

  @Test
  fun anUploadTheProviderNeverSawHasNoFileToSendButKeepsItsAttachment() = runTest {
    val transport = FakeTransport { jsonResponse(200, """{"attachmentId":"gemi_att_1","name":"scan.png","mimeType":"image/png"}""") }
    val chat = session(transport)

    val upload = chat.upload(byteArrayOf(1, 2), "scan.png", "image/png")

    assertEquals("gemi_att_1", upload.attachmentId)
    assertNull(upload.fileId)
    // Nothing to put in `files`: an empty id sent to the provider is the
    // failure this shape exists to prevent.
    assertNull(upload.file)
  }

  @Test
  fun aDowngradedUploadSaysWhy() = runTest {
    val transport = FakeTransport { jsonResponse(200, """{"fileId":"file_1","downgraded":"no_scope"}""") }
    val chat = session(transport)

    val upload = chat.upload(byteArrayOf(1), "a.pdf", "application/pdf")

    assertEquals("no_scope", upload.downgraded)
    assertNull(upload.attachmentId)
  }

  @Test
  fun aFileTravelsInTheTurnAndInTheOptimisticMessage() = runTest {
    val transport = FakeTransport { sse(*answer("Got it.")) }
    val chat = session(transport)

    chat.send(ClientTurn(text = "See attached", files = listOf(ChatFile("file_1", "a.pdf"))))

    assertTrue(jsonEquals(jsonOf("""{"text":"See attached","files":[{"fileId":"file_1","name":"a.pdf"}]}"""), transport.requests[0].body.body["turn"]))
    assertTrue(
      jsonEquals(
        jsonOf("""[{"type":"text","text":"See attached"},{"type":"file","fileId":"file_1","name":"a.pdf"}]"""),
        chat.state.value.messages[0].json["content"],
      )
    )
  }

  @Test
  fun aTurnThatEndsWithoutSuspendingStillSettlesOnAnImmediateDispatcher() = runTest {
    // Nothing here suspends, so on an immediate dispatcher each turn is over
    // before `send` has returned from starting it.
    val failing = ChatSession(ENDPOINT, immediateScope(), transport = FakeTransport { throw IllegalStateException("bad url") })
    failing.send("Hi")
    assertEquals(ChatStatus.Error, failing.state.value.status)
    assertEquals("bad url", failing.state.value.error?.message)

    val answered = ChatSession(ENDPOINT, immediateScope(), transport = FakeTransport { sse(*answer("Hello.")) })
    answered.send("Hi")
    assertEquals(ChatStatus.Idle, answered.state.value.status)
    // And the next turn is not taken for a second send cutting the first.
    answered.send("Again")
    assertEquals(FinishReason.Stop, answered.state.value.messages[1].finishReason)
  }

  @Test
  fun anAttachThatEndsWithoutSuspendingSettlesOnAnImmediateDispatcher() = runTest {
    val chat = ChatSession(ENDPOINT, immediateScope(), threadId = "th_1", transport = FakeTransport { sse(*answer("Done.")) })
    assertEquals("Done.", chat.state.value.messages[0].text)
    assertEquals(ChatStatus.Idle, chat.state.value.status)
  }

  @Test
  fun responsesThatAreNotReadAreClosed() = runTest {
    // A response left open is a connection that never goes back to the pool.
    val stopped = ClosableResponse(200, """{"stopped":true}""")
    val missed = ClosableResponse(204)
    val stream = OpenStream()
    val transport = FakeTransport { request ->
      when {
        request.url.endsWith("/stop") -> stopped.response
        request.url.endsWith("/attach") -> missed.response
        else -> stream.response
      }
    }
    val chat = session(transport, threadId = "th_1", attach = true)
    runCurrent()
    assertTrue(missed.closed)

    val sending = launch { chat.send("Hi") }
    runCurrent()
    chat.stop()
    stream.finish()
    sending.join()
    assertTrue(stopped.closed)
  }

  @Test
  fun anUploadsNameCannotBreakOutOfItsHeader() = runTest {
    val transport = FakeTransport { jsonResponse(200, """{"fileId":"file_1"}""") }
    val chat = session(transport)

    chat.upload(byteArrayOf(1), "a\"b\r\nX-Injected: 1.pdf", "application/pdf")

    val form = transport.requests[0].request.body.decodeToString()
    assertTrue(form.contains("""filename="a%22b%0D%0AX-Injected: 1.pdf""""))
    assertTrue(!form.contains("\r\nX-Injected"))
  }
}
