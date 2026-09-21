import Foundation
import Testing

@testable import GemiChat

// `ChatSession` against a real `AgentController` (`e2e/server.ts`). Skipped
// unless `GEMI_E2E_URL` names a running one:
//
//   bun packages/gemi-swift/e2e/server.ts 47123 &
//   GEMI_E2E_URL=http://127.0.0.1:47123 swift test
//
// What these catch that the scripted-transport tests cannot is disagreement
// with the server itself — a field it does not read, a signature it will not
// verify, an event it encodes differently than `types.ts` says.

private let server = ProcessInfo.processInfo.environment["GEMI_E2E_URL"].flatMap(URL.init(string:))

@MainActor
@Suite(.enabled(if: server != nil, "set GEMI_E2E_URL to a running e2e/server.ts"))
struct EndToEndTests {
  let support = server?.appendingPathComponent("api/support")

  func session(threadId: String? = nil) -> ChatSession<E2eAgent> {
    ChatSession<E2eAgent>(endpoint: support!, threadId: threadId, attach: false)
  }

  func newThread() async throws -> String {
    var request = URLRequest(url: support!.appendingPathComponent("threads"))
    request.httpMethod = "POST"
    let (data, _) = try await URLSession.shared.data(for: request)
    return try #require(JSONValue.parse(data)?["threadId"]?.stringValue)
  }

  @Test func aStatelessConversationKeepsItsOwnHistory() async {
    let chat = session()
    await chat.send("hello")
    #expect(chat.error == nil)
    #expect(chat.messages.map(\.text) == ["hello", "Hello from gemi."])
    #expect(chat.messages[1].usage?.totalTokens == 15)

    // The second turn carries the first in `messages`, and the server takes it.
    await chat.send("hello again")
    #expect(chat.error == nil)
    #expect(chat.messages.count == 4)
  }

  @Test func anApprovalRoundTripsItsSignature() async {
    let chat = session()
    await chat.send("charge")
    #expect(chat.status == .awaitingInput)
    guard case .charge(let call) = chat.typedPending.first else {
      Issue.record("expected charge to be pending, got \(chat.pending)")
      return
    }
    #expect(call.input?.amountCents == 500)

    await chat.approve(call, true).value

    #expect(chat.error == nil)
    #expect(chat.status == .idle)
    let results = chat.messages.flatMap { chat.toolResults(in: $0) }
    guard case .charge(let result) = results.first else {
      Issue.record("expected a charge result, got \(results)")
      return
    }
    #expect(result.outcome == .ok(.init(receiptId: "rc_500")))
  }

  @Test func aRefusalReachesTheModelAsDenied() async {
    let chat = session()
    await chat.send("charge")
    await chat.approve(chat.pending[0].toolCallId, false, reason: "too much").value

    #expect(chat.error == nil)
    let results = chat.messages.flatMap { chat.toolResults(in: $0) }
    guard case .charge(let result) = results.first else {
      Issue.record("expected a charge result, got \(results)")
      return
    }
    #expect(result.outcome == .denied(cause: "refused", reason: "too much"))
  }

  @Test func aQuestionIsAnsweredWithTheToolsOwnType() async {
    let chat = session()
    await chat.send("ask")
    guard case .ask(let call) = chat.typedPending.first else {
      Issue.record("expected ask to be pending, got \(chat.pending)")
      return
    }
    #expect(call.input?.question == "Which order?")

    await chat.answer(call, with: .init(answer: "The March one")).value

    #expect(chat.error == nil)
    #expect(chat.messages.last?.text.contains("The March one") == true)
  }

  @Test func progressArrivesTypedOnTheToolCall() async {
    let chat = session()
    await chat.send("count")
    let calls = chat.messages.flatMap { chat.toolCalls(in: $0) }
    guard case .count(let call) = calls.first else {
      Issue.record("expected a count call, got \(calls)")
      return
    }
    #expect(call.progress == [.init(n: 1), .init(n: 2), .init(n: 3)])
  }

  @Test func aThreadedConversationIsTheServersToKeep() async throws {
    let threadId = try await newThread()
    let chat = session(threadId: threadId)
    await chat.send("hello")
    #expect(chat.error == nil)
    #expect(chat.threadId == threadId)

    // A fresh session on the same thread, restored from what the first
    // persisted, continues it.
    let restored = ChatSession<E2eAgent>(
      endpoint: support!, threadId: threadId, initialMessages: chat.messages,
      cursor: chat.cursor, attach: false)
    await restored.send("hello")
    #expect(restored.error == nil)
    #expect(restored.messages.count == 4)
  }

  @Test func stopEndsTheRunOnTheServer() async throws {
    let threadId = try await newThread()
    let stops = StopRecorder()
    let chat = ChatSession<E2eAgent>(
      endpoint: support!, threadId: threadId, attach: false, transport: stops)
    let sending = Task { await chat.send("slow") }
    await eventually { chat.messages.last?.text.contains("2 ") == true }

    await chat.stop()
    await sending.value

    #expect(chat.error == nil)
    #expect(chat.messages.last?.finishReason == .aborted)
    // The controller found the run by what `stop()` sent. A later turn would
    // end it too, so that the thread takes one is no proof the stop landed.
    #expect(stops.answers == [["stopped": true]])
    await chat.send("hello")
    #expect(chat.error == nil)
    #expect(chat.messages.last?.text == "Hello from gemi.")
  }

  @Test func aSessionAttachesToARunAnotherOneStarted() async throws {
    let threadId = try await newThread()
    let first = session(threadId: threadId)
    let sending = Task { await first.send("slow") }
    await eventually { first.messages.last?.text.contains("1 ") == true }

    // The app relaunched mid-answer: a new session on the same thread.
    let second = ChatSession<E2eAgent>(endpoint: support!, threadId: threadId)
    await eventually { second.messages.last?.text.contains("5 ") == true }
    #expect(second.status == .streaming)

    await second.stop()
    first.close()
    await sending.value
  }

  @Test func anUploadReturnsTheProvidersFileId() async throws {
    let chat = session()
    let upload = try await chat.upload(
      Data("%PDF".utf8), name: "a.pdf", mimeType: "application/pdf")
    #expect(upload.fileId == "file_a.pdf")
  }
}

/// `URLSessionTransport`, keeping what the server answered to each `/stop`.
final class StopRecorder: ChatTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var _answers: [JSONValue] = []
  private let inner = URLSessionTransport()

  var answers: [JSONValue] { lock.withLock { _answers } }

  func send(_ request: URLRequest) async throws -> ChatResponse {
    let response = try await inner.send(request)
    guard request.url!.path.hasSuffix("/stop") else { return response }
    let data = try await response.data()
    lock.withLock { _answers.append(JSONValue.parse(data) ?? .null) }
    return ChatResponse(
      statusCode: response.statusCode,
      body: AsyncThrowingStream {
        $0.yield(data)
        $0.finish()
      })
  }
}
