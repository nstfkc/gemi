import Foundation
import Testing

@testable import GemiChat

// `ChatSession` against a scripted server: what it sends, and what it does
// with what comes back. The frame handling is the reducer's and is covered by
// the conformance corpus; this is the part around it — `useChat`'s.

/// Stands in for the server. Every request is recorded; each is answered by
/// the handler, which may keep a stream open until the test says otherwise.
final class FakeTransport: ChatTransport, @unchecked Sendable {
  struct Recorded {
    let request: URLRequest
    var path: String { request.url!.path }
    var body: JSONValue { JSONValue.parse(request.httpBody ?? Data()) ?? .null }
  }

  private let lock = NSLock()
  private var _requests: [Recorded] = []
  var handler: @Sendable (URLRequest) async throws -> ChatResponse

  init(handler: @escaping @Sendable (URLRequest) async throws -> ChatResponse) {
    self.handler = handler
  }

  var requests: [Recorded] { lock.withLock { _requests } }

  func send(_ request: URLRequest) async throws -> ChatResponse {
    lock.withLock { _requests.append(Recorded(request: request)) }
    return try await handler(request)
  }
}

/// A finished SSE response carrying these events, numbered from 0.
func sse(_ events: [JSONValue], status: Int = 200) -> ChatResponse {
  let text = events.enumerated().map { index, event in
    "id: \(index)\ndata: \(String(decoding: try! event.jsonData(), as: UTF8.self))\n\n"
  }.joined()
  return ChatResponse(
    statusCode: status,
    body: AsyncThrowingStream {
      $0.yield(Data(text.utf8))
      $0.finish()
    })
}

func json(status: Int, _ body: JSONValue) -> ChatResponse {
  ChatResponse(
    statusCode: status,
    body: AsyncThrowingStream {
      $0.yield(try! body.jsonData())
      $0.finish()
    })
}

/// A stream the test feeds by hand and that stays open until finished, for
/// catching a session mid-run.
final class OpenStream: @unchecked Sendable {
  let response: ChatResponse
  private let continuation: AsyncThrowingStream<Data, Error>.Continuation
  private var seq = 0

  init() {
    var captured: AsyncThrowingStream<Data, Error>.Continuation!
    let body = AsyncThrowingStream<Data, Error> { captured = $0 }
    continuation = captured
    response = ChatResponse(statusCode: 200, body: body)
  }

  func emit(_ event: JSONValue) {
    let text = "id: \(seq)\ndata: \(String(decoding: try! event.jsonData(), as: UTF8.self))\n\n"
    seq += 1
    continuation.yield(Data(text.utf8))
  }

  func finish() { continuation.finish() }
}

let endpoint = URL(string: "https://example.test/api/support")!

/// A whole answer to one turn.
func answer(_ text: String, run: String = "run_1", message: String = "m1") -> [JSONValue] {
  [
    ["type": "run-start", "runId": .string(run)],
    ["type": "message-start", "messageId": .string(message), "role": "assistant"],
    ["type": "text-delta", "messageId": .string(message), "delta": .string(text)],
    ["type": "message-end", "messageId": .string(message), "finishReason": "stop"],
    ["type": "run-end", "runId": .string(run), "finishReason": "stop"],
  ]
}

/// Polls until `condition` holds, for a stream the test feeds by hand.
@MainActor
func eventually(_ condition: () -> Bool) async {
  for _ in 0..<500 {
    if condition() { return }
    try? await Task.sleep(nanoseconds: 1_000_000)
  }
  Issue.record("condition never held")
}

@MainActor
@Suite struct ChatSessionTests {
  @Test func aStatelessTurnPostsTheHistoryBeforeItAndStreamsTheAnswer() async {
    let transport = FakeTransport { _ in sse(answer("Hello.")) }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)
    var finished: [String] = []
    chat.onFinish = { finished.append($0.id) }

    await chat.send("Hi")

    let body = transport.requests[0].body
    #expect(transport.requests[0].path == "/api/support")
    #expect(body["turn"] == ["text": "Hi"])
    // The turn itself is never in `messages`, or the server would see it twice.
    #expect(body["messages"] == [])
    #expect(body["threadId"] == nil)
    #expect(body["clientRunId"]?.stringValue?.hasPrefix("local_") == true)

    #expect(chat.messages.map(\.role) == [.user, .assistant])
    #expect(chat.messages[0].text == "Hi")
    #expect(chat.messages[1].text == "Hello.")
    #expect(chat.status == .idle)
    #expect(finished == ["m1"])
    #expect(chat.cursor == ChatCursor(runId: "run_1", seq: 4))
  }

  @Test func aThreadedTurnNamesTheThreadAndSendsNoHistory() async {
    let transport = FakeTransport { _ in sse(answer("Hello.")) }
    let chat = UntypedChatSession(
      endpoint: endpoint, threadId: "th_1", attach: false, body: ["locale": "tr"],
      transport: transport)

    await chat.send("Hi")

    let body = transport.requests[0].body
    #expect(body["threadId"] == "th_1")
    #expect(body["messages"] == nil)
    #expect(body["locale"] == "tr")
  }

  @Test func headersAreAskedForOnEveryRequest() async {
    let transport = FakeTransport { _ in sse(answer("Hello.")) }
    let counter = Counter()
    let chat = UntypedChatSession(
      endpoint: endpoint, headers: { ["Authorization": "Bearer \(counter.next())"] },
      transport: transport)

    await chat.send("one")
    await chat.send("two")

    #expect(
      transport.requests.map { $0.request.value(forHTTPHeaderField: "Authorization") } == [
        "Bearer 1", "Bearer 2",
      ])
  }

  @Test func theHistoryGoesOutWithoutProgressLogs() async {
    let transport = FakeTransport { _ in
      sse([
        ["type": "run-start", "runId": "run_1"],
        ["type": "message-start", "messageId": "m1", "role": "assistant"],
        [
          "type": "tool-call", "messageId": "m1",
          "part": [
            "type": "tool-call", "toolCallId": "tc_1", "name": "bash", "input": ["command": "ls"],
          ],
        ],
        ["type": "tool-progress", "toolCallId": "tc_1", "data": ["stage": "started", "pid": 1]],
        ["type": "message-end", "messageId": "m1", "finishReason": "stop"],
        ["type": "run-end", "runId": "run_1", "finishReason": "stop"],
      ])
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)
    await chat.send("go")
    await chat.send("again")

    // The session keeps every yield; the request does not carry them.
    guard case .toolCall(let part) = chat.messages[1].content[0] else {
      Issue.record("expected a tool call")
      return
    }
    #expect(part.progress.count == 1)
    let posted = transport.requests[1].body["messages"]?.arrayValue ?? []
    #expect(posted.count == 2)
    #expect(posted[1]["content"]?.arrayValue?[0]["progress"] == nil)
    #expect(posted[1]["content"]?.arrayValue?[0]["toolCallId"] == "tc_1")
  }

  @Test func anHTTPFailureIsAnErrorInTheStreamsShape() async {
    let transport = FakeTransport { _ in
      json(status: 404, ["error": ["code": "thread_not_found", "message": "No thread th_9"]])
    }
    let chat = UntypedChatSession(
      endpoint: endpoint, threadId: "th_9", attach: false, transport: transport)
    var reported: [String] = []
    chat.onError = { reported.append($0.code) }

    await chat.send("Hi")

    #expect(chat.status == .error)
    #expect(chat.error?.code == "thread_not_found")
    #expect(chat.error?.message == "No thread th_9")
    #expect(chat.error?.retryable == false)
    #expect(reported == ["thread_not_found"])
  }

  @Test func approvalsGivenTogetherGoOutAsOneTurn() async {
    let transport = FakeTransport { request in
      if request.url!.path.hasSuffix("support"),
        JSONValue.parse(request.httpBody!)?["turn"]?["toolResults"] != nil
      {
        return sse(answer("Done.", run: "run_2", message: "m2"))
      }
      return sse([
        ["type": "run-start", "runId": "run_1"],
        [
          "type": "awaiting-input", "runId": "run_1",
          "pending": [
            [
              "toolCallId": "tc_1", "name": "charge", "input": [:], "kind": "approval",
              "signature": "s1",
            ],
            [
              "toolCallId": "tc_2", "name": "refund_order", "input": [:], "kind": "approval",
              "signature": "s2", "path": ["tc_0"],
            ],
          ],
        ],
        ["type": "run-end", "runId": "run_1", "finishReason": "awaiting-input"],
      ])
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)
    var asked = 0
    chat.onAwaitingInput = { asked = $0.count }
    await chat.send("Refund it")
    #expect(chat.status == .awaitingInput)
    #expect(asked == 2)

    // The loop an app writes. Sent one by one, the first turn would refuse the
    // second call.
    var flushes: [Task<Void, Never>] = []
    for call in chat.pending { flushes.append(chat.approve(call.toolCallId, true)) }
    await flushes[0].value

    #expect(transport.requests.count == 2)
    let turn = transport.requests[1].body["turn"]
    #expect(
      turn == [
        "toolResults": [
          ["toolCallId": "tc_1", "signature": "s1", "approve": true],
          // The path comes back exactly as it arrived.
          ["toolCallId": "tc_2", "signature": "s2", "path": ["tc_0"], "approve": true],
        ]
      ])
    #expect(chat.status == .idle)
    #expect(chat.pending.isEmpty)
  }

  @Test func anEmptyReasonIsLeftOutAsUseChatLeavesItOut() async {
    let transport = FakeTransport { request in
      if JSONValue.parse(request.httpBody!)?["turn"]?["toolResults"] != nil {
        return sse(answer("Not charged.", run: "run_2", message: "m2"))
      }
      return sse([
        ["type": "run-start", "runId": "run_1"],
        [
          "type": "awaiting-input", "runId": "run_1",
          "pending": [
            [
              "toolCallId": "tc_1", "name": "charge", "input": [:], "kind": "approval",
              "signature": "s1",
            ],
            [
              "toolCallId": "tc_2", "name": "charge", "input": [:], "kind": "approval",
              "signature": "s2",
            ],
          ],
        ],
        ["type": "run-end", "runId": "run_1", "finishReason": "awaiting-input"],
      ])
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)
    await chat.send("Charge me twice")

    // A text field bound straight to the reason hands over "" when left blank,
    // and the model should read that as no reason, not as "refused: ".
    let flush = chat.approve("tc_1", false, reason: "")
    _ = chat.approve("tc_2", false, reason: "too much")
    await flush.value

    #expect(
      transport.requests[1].body["turn"]?["toolResults"] == [
        ["toolCallId": "tc_1", "signature": "s1", "approve": false],
        ["toolCallId": "tc_2", "signature": "s2", "approve": false, "reason": "too much"],
      ])
  }

  @Test func aTypedAnswerIsEncodedByTheToolsOwnType() async {
    let transport = FakeTransport { request in
      if JSONValue.parse(request.httpBody!)?["turn"]?["toolResults"] != nil {
        return sse(answer("Thanks.", run: "run_2", message: "m2"))
      }
      return sse([
        ["type": "run-start", "runId": "run_1"],
        [
          "type": "awaiting-input", "runId": "run_1",
          "pending": [
            [
              "toolCallId": "tc_1", "name": "ask", "input": ["question": "Which order?"],
              "kind": "question", "signature": "s1",
            ]
          ],
        ],
        ["type": "run-end", "runId": "run_1", "finishReason": "awaiting-input"],
      ])
    }
    let chat = ChatSession<SupportAgent>(endpoint: endpoint, transport: transport)
    await chat.send("Refund my order")

    guard case .ask(let call) = chat.typedPending.first else {
      Issue.record("expected the ask tool")
      return
    }
    #expect(call.input?.question == "Which order?")
    await chat.answer(call, with: .init(answer: "The March one")).value

    #expect(
      transport.requests[1].body["turn"]?["toolResults"] == [
        ["toolCallId": "tc_1", "signature": "s1", "output": ["answer": "The March one"]]
      ])
  }

  @Test func answeringACallTheSessionIsNotHoldingIsAnErrorNotARequest() async {
    let transport = FakeTransport { _ in sse(answer("Hello.")) }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    await chat.approve("tc_nowhere", true).value

    #expect(transport.requests.isEmpty)
    #expect(chat.error?.code == "invalid_tool_result")
  }

  @Test func stopMarksTheTurnAbortedAtOnceAndTellsTheServer() async {
    let stream = OpenStream()
    let transport = FakeTransport { request in
      request.url!.path.hasSuffix("/stop") ? json(status: 200, ["stopped": true]) : stream.response
    }
    let chat = UntypedChatSession(
      endpoint: endpoint, threadId: "th_1", attach: false, transport: transport)

    let sending = Task { await chat.send("Write an essay") }
    stream.emit(["type": "run-start", "runId": "run_1"])
    stream.emit(["type": "message-start", "messageId": "m1", "role": "assistant"])
    stream.emit(["type": "text-delta", "messageId": "m1", "delta": "Once upon"])
    await eventually { chat.messages.count == 2 && chat.messages[1].text == "Once upon" }

    await chat.stop()
    // A token that lands after stop is not applied.
    stream.emit(["type": "text-delta", "messageId": "m1", "delta": " a time"])
    stream.finish()
    await sending.value

    #expect(chat.messages[1].text == "Once upon")
    #expect(chat.messages[1].finishReason == .aborted)
    #expect(chat.status == .idle)
    let stop = transport.requests.last!
    #expect(stop.path == "/api/support/stop")
    #expect(stop.body["runId"] == "run_1")
    #expect(stop.body["threadId"] == "th_1")
    #expect(stop.body["clientRunId"] == transport.requests[0].body["clientRunId"])
  }

  @Test func framesAfterCloseAreNotAppliedEvenFromTheSameChunk() async {
    // One chunk carrying the rest of the run: nothing between its frames would
    // notice a cancellation on its own.
    let transport = FakeTransport { _ in
      sse([
        ["type": "run-start", "runId": "run_1"],
        ["type": "message-start", "messageId": "m1", "role": "assistant"],
        ["type": "message-end", "messageId": "m1", "finishReason": "stop"],
        ["type": "message-start", "messageId": "m2", "role": "assistant"],
        ["type": "text-delta", "messageId": "m2", "delta": "after close"],
      ])
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)
    chat.onFinish = { _ in chat.close() }

    await chat.send("Hi")

    #expect(chat.messages.map(\.role) == [.user, .assistant])
  }

  @Test func stopBeforeTheRunHasAnIdStillNamesIt() async {
    let stream = OpenStream()
    let transport = FakeTransport { request in
      request.url!.path.hasSuffix("/stop") ? json(status: 200, ["stopped": true]) : stream.response
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    let sending = Task { await chat.send("Hi") }
    await eventually { transport.requests.count == 1 }
    await chat.stop()
    stream.finish()
    await sending.value

    // No `run-start` yet, so no runId: the client's own id is the handle.
    let stop = transport.requests.last!
    #expect(stop.path == "/api/support/stop")
    #expect(stop.body == ["clientRunId": transport.requests[0].body["clientRunId"]!])
  }

  @Test func aSecondSendCutsTheFirstAndStopsItsRun() async {
    let first = OpenStream()
    let transport = FakeTransport { request in
      let body = JSONValue.parse(request.httpBody!)
      if request.url!.path.hasSuffix("/stop") { return json(status: 200, ["stopped": true]) }
      return body?["turn"]?["text"] == "first"
        ? first.response : sse(answer("Second.", run: "run_2", message: "m2"))
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    let sending = Task { await chat.send("first") }
    first.emit(["type": "run-start", "runId": "run_1"])
    first.emit(["type": "message-start", "messageId": "m1", "role": "assistant"])
    first.emit(["type": "text-delta", "messageId": "m1", "delta": "Half an ans"])
    await eventually { chat.messages.count == 2 && chat.messages[1].text == "Half an ans" }

    await chat.send("second")
    first.finish()
    await sending.value

    #expect(chat.messages.map(\.text) == ["first", "Half an ans", "second", "Second."])
    // The cut turn says it was cut; the next run's `run-end` must not relabel it.
    #expect(chat.messages[1].finishReason == .aborted)
    #expect(chat.messages[3].finishReason == .stop)
    await eventually { transport.requests.contains { $0.path.hasSuffix("/stop") } }
    let stop = transport.requests.first { $0.path.hasSuffix("/stop") }!
    #expect(stop.body["runId"] == "run_1")
    #expect(stop.body["threadId"] == nil)
    // The superseded history went out with the second turn, aborted as it is.
    let posted = transport.requests.first { $0.body["turn"]?["text"] == "second" }!.body
    #expect(posted["messages"]?.arrayValue?[1]["finishReason"] == "aborted")
  }

  @Test func aSessionOnAThreadAttachesToTheRunStillGoing() async {
    let transport = FakeTransport { request in
      #expect(request.url!.path == "/api/support/attach")
      // The tail of a run this client had seen up to seq 1.
      return sse([
        ["type": "run-start", "runId": "run_1"],
        ["type": "message-start", "messageId": "m1", "role": "assistant"],
        ["type": "text-delta", "messageId": "m1", "delta": "already had this"],
        ["type": "text-delta", "messageId": "m1", "delta": " and the rest"],
        ["type": "message-end", "messageId": "m1", "finishReason": "stop"],
      ])
    }
    let restored = AgentMessage(json: [
      "id": "m1", "role": "assistant", "createdAt": "t",
      "content": [["type": "text", "text": "already had this"]],
    ])
    let chat = UntypedChatSession(
      endpoint: endpoint, threadId: "th_1", initialMessages: [restored],
      cursor: ChatCursor(runId: "run_1", seq: 2), transport: transport)

    await eventually { chat.messages.first?.finishReason == .stop }

    #expect(transport.requests[0].body == ["threadId": "th_1", "cursor": 2, "runId": "run_1"])
    // Frames at or below the cursor are replay: the text is not doubled.
    #expect(chat.messages[0].text == "already had this and the rest")
  }

  @Test func anAttachMissIsReportedSoTheAppCanReReadTheThread() async {
    let transport = FakeTransport { _ in json(status: 404, ["code": "no_live_run"]) }
    let chat = UntypedChatSession(endpoint: endpoint, threadId: "th_1", transport: transport)
    var missed: [String] = []
    chat.onAttachMiss = { missed.append($0) }

    await eventually { !missed.isEmpty }

    #expect(missed == ["th_1"])
    #expect(chat.status == .idle)
    #expect(chat.error == nil)
  }

  @Test func regenerateReplacesTheLastAnswerAndAsksAgain() async {
    let transport = FakeTransport { _ in sse(answer("Try two.", run: "run_2", message: "m2")) }
    let history = [
      AgentMessage(json: [
        "id": "u1", "role": "user", "createdAt": "t", "content": [["type": "text", "text": "Q"]],
      ]),
      AgentMessage(json: [
        "id": "m1", "role": "assistant", "createdAt": "t", "finishReason": "stop",
        "content": [["type": "text", "text": "Try one."]],
      ]),
    ]
    let chat = UntypedChatSession(
      endpoint: endpoint, initialMessages: history, transport: transport)

    await chat.regenerate()

    #expect(transport.requests[0].body["turn"] == ["text": "Q"])
    #expect(transport.requests[0].body["messages"] == [])
    #expect(chat.messages.map(\.text) == ["Q", "Try two."])
  }

  @Test func anUploadIsMultipartAndReturnsTheFileToSend() async throws {
    let transport = FakeTransport { _ in json(status: 200, ["fileId": "file_1"]) }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    let upload = try await chat.upload(
      Data("%PDF".utf8), name: "invoice.pdf", mimeType: "application/pdf")

    #expect(
      upload.file == ChatFile(fileId: "file_1", name: "invoice.pdf", mimeType: "application/pdf"))
    let request = transport.requests[0].request
    #expect(request.url!.path == "/api/support/files")
    #expect(
      request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=")
        == true)
    let form = String(decoding: request.httpBody!, as: UTF8.self)
    #expect(form.contains(#"name="file"; filename="invoice.pdf""#))
    #expect(form.contains("%PDF"))
  }

  @Test func anUploadsFilenameIsEscapedAsFormDataEscapesIt() async throws {
    let transport = FakeTransport { _ in json(status: 200, ["fileId": "file_1"]) }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    _ = try await chat.upload(
      Data("%PDF".utf8), name: "we \"q\".pdf\r\nX-Evil: 1", mimeType: "application/pdf")

    let form = String(decoding: transport.requests[0].request.httpBody!, as: UTF8.self)
    #expect(form.contains(#"filename="we %22q%22.pdf%0D%0AX-Evil: 1""#))
    #expect(!form.contains("\r\nX-Evil"))
  }

  @Test func anUploadTheProviderNeverSawHasNoFileToSendButKeepsItsAttachment() async throws {
    let transport = FakeTransport { _ in
      json(
        status: 200, ["attachmentId": "gemi_att_1", "name": "scan.png", "mimeType": "image/png"])
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    let upload = try await chat.upload(Data([1, 2]), name: "scan.png", mimeType: "image/png")

    #expect(upload.attachmentId == "gemi_att_1")
    #expect(upload.fileId == nil)
    // Nothing to put in `files`: an empty id sent to the provider is the
    // failure this shape exists to prevent.
    #expect(upload.file == nil)
  }

  @Test func aDowngradedUploadSaysWhy() async throws {
    let transport = FakeTransport { _ in
      json(status: 200, ["fileId": "file_1", "downgraded": "no_scope"])
    }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    let upload = try await chat.upload(Data([1]), name: "a.pdf", mimeType: "application/pdf")

    #expect(upload.downgraded == "no_scope")
    #expect(upload.attachmentId == nil)
  }

  @Test func aFileTravelsInTheTurnAndInTheOptimisticMessage() async {
    let transport = FakeTransport { _ in sse(answer("Got it.")) }
    let chat = UntypedChatSession(endpoint: endpoint, transport: transport)

    await chat.send(
      ClientTurn(text: "See attached", files: [ChatFile(fileId: "file_1", name: "a.pdf")]))

    #expect(
      transport.requests[0].body["turn"] == [
        "text": "See attached", "files": [["fileId": "file_1", "name": "a.pdf"]],
      ])
    #expect(
      chat.messages[0].json["content"] == [
        ["type": "text", "text": "See attached"],
        ["type": "file", "fileId": "file_1", "name": "a.pdf"],
      ])
  }
}

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func next() -> Int {
    lock.withLock {
      value += 1
      return value
    }
  }
}
