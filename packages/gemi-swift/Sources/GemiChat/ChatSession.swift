import Foundation
import Observation

/// What the UI is waiting on. `useChat`'s `ChatStatus`.
///
/// `awaitingInput` is its own state rather than a flavour of idle: the run is
/// over, but the conversation is holding a question, and a UI that cannot tell
/// the difference either looks hung or looks finished.
public enum ChatStatus: Sendable, Hashable {
  case idle
  case submitted
  case streaming
  case awaitingInput
  case error
}

/// Where a client left off in a run: what `/attach` resumes from. Persist it
/// beside the messages — the two belong together, and restoring one without
/// the other is how an answer ends up printed twice.
public struct ChatCursor: Sendable, Hashable, Codable {
  public var runId: String?
  public var seq: Int

  public init(runId: String?, seq: Int) {
    self.runId = runId
    self.seq = seq
  }
}

/// A conversation with a gemi agent: `useChat` for iOS.
///
/// A port of `ai/useChat.tsx`, and deliberately a close one — the web hook's
/// comments carry the reasoning for each behaviour below, and a change to one
/// belongs there first. The frame handling itself is the shared reducer
/// (`ChatState`), held to the TypeScript one by the recorded corpus.
///
///     let chat = ChatSession<SupportAgent>(
///       endpoint: URL(string: "https://example.com/api/support")!,
///       headers: { ["Authorization": "Bearer \(try await tokens.current())"] })
///     await chat.send("Where is my order?")
///
/// `Agent` is the type `gemi ai:generate-client` wrote, and is only how the
/// typed views read the transcript; `UntypedChatSession` reads it raw.
@MainActor
@Observable
public final class ChatSession<Agent: AgentSchema> {
  public typealias Headers = @Sendable () async throws -> [String: String]

  // MARK: state

  public private(set) var state: ChatState
  private var phase: Phase = .idle
  private enum Phase { case idle, submitted, streaming }

  /// The transcript, tools and all. Read a part typed with
  /// `Agent.toolCall(part)`, or through `toolCalls(in:)`.
  public var messages: [AgentMessage] { state.messages }
  /// Non-empty exactly when `status == .awaitingInput`.
  public var pending: [PendingToolCall] { state.pending }
  /// `pending`, typed by the agent's schema.
  public var typedPending: [Agent.Pending] { state.pending.map(Agent.pending) }
  /// Cleared by the next send, so a retry does not have to clear it.
  public var error: AgentError? { state.error }
  /// Set once the server has assigned one.
  public var threadId: String? { state.threadId }
  /// The run being streamed or attached to, if any.
  public var runId: String? { state.runId }
  /// How far this client has got. Persist it with `messages`.
  public var cursor: ChatCursor { ChatCursor(runId: state.cursorRunId, seq: state.seq) }
  /// The deferred tools the model has pulled in during the run in flight.
  public var loadedTools: [String] { state.loadedTools }

  public var status: ChatStatus {
    // Ordered so `pending` non-empty exactly when awaiting input is true by
    // construction.
    if !state.pending.isEmpty { return .awaitingInput }
    switch phase {
    case .submitted: return .submitted
    case .streaming: return .streaming
    case .idle: return state.error == nil ? .idle : .error
    }
  }

  // MARK: configuration

  /// The agent's route, e.g. `https://example.com/api/support`. `/stop`,
  /// `/attach` and `/files` hang off it.
  public let endpoint: URL
  /// Asked before every request, so a token that rotates is always current.
  @ObservationIgnored public var headers: Headers
  /// Merged into every send's body, for what the agent's controller reads off
  /// the request that is not a message.
  @ObservationIgnored public var body: JSONObject
  @ObservationIgnored public let transport: any ChatTransport

  @ObservationIgnored public var onFinish: ((AgentMessage) -> Void)?
  @ObservationIgnored public var onError: ((AgentError) -> Void)?
  @ObservationIgnored public var onAwaitingInput: (([PendingToolCall]) -> Void)?
  /// The attach probe found no run. On more than one server instance that is
  /// ambiguous — the run may be alive on another one — and re-reading the
  /// thread is how an app shows the answer anyway. See `useChat`'s
  /// `onAttachMiss`.
  @ObservationIgnored public var onAttachMiss: ((String) -> Void)?

  /// The request in flight and the id `stop()` names it by.
  @ObservationIgnored private var inFlight: InFlight?
  private struct InFlight {
    let id: UUID
    let task: Task<Void, Never>
    let clientRunId: String?
  }

  /// Answers queued in one main-actor turn, sent as one turn.
  @ObservationIgnored private var queued: (results: [ClientToolResult], flush: Task<Void, Never>)?

  /// - Parameters:
  ///   - threadId: continues a server-side thread. Omitted, the session keeps
  ///     the history and sends it with each turn — the stateless default. The
  ///     id is the store's: an app route mints it.
  ///   - initialMessages: restored history.
  ///   - cursor: where the client that produced `initialMessages` left off.
  ///   - attach: pick up a run still going on `threadId`. Needs a `threadId`.
  public init(
    endpoint: URL,
    threadId: String? = nil,
    initialMessages: [AgentMessage] = [],
    cursor: ChatCursor? = nil,
    attach: Bool = true,
    headers: @escaping Headers = { [:] },
    body: JSONObject = [:],
    transport: any ChatTransport = URLSessionTransport()
  ) {
    self.endpoint = endpoint
    self.headers = headers
    self.body = body
    self.transport = transport
    self.state = ChatState(
      messages: initialMessages, threadId: threadId, seq: cursor?.seq,
      cursorRunId: cursor?.runId)
    if attach, let threadId { attachToRun(threadId: threadId) }
  }

  /// Drops the stream without stopping the run — what the web hook does on
  /// unmount. The run keeps going on the server, and a session made later on
  /// the same thread attaches to it. Call it when the screen goes away; a
  /// session streaming a turn is otherwise kept alive by that turn until it
  /// ends. `stop()` is the one that ends the run.
  public func close() {
    inFlight?.task.cancel()
    inFlight = nil
    phase = .idle
  }

  // MARK: typed views

  /// Every tool call in a message, typed.
  public func toolCalls(in message: AgentMessage) -> [Agent.ToolCall] {
    message.content.compactMap {
      if case .toolCall(let part) = $0 { Agent.toolCall(part) } else { nil }
    }
  }

  /// Every tool result in a message, typed.
  public func toolResults(in message: AgentMessage) -> [Agent.ToolResult] {
    message.content.compactMap {
      if case .toolResult(let part) = $0 { Agent.toolResult(part) } else { nil }
    }
  }

  /// A message's structured answer, once it parses.
  public func output(of message: AgentMessage) -> Agent.Output? {
    for part in message.content {
      if case .output(let output) = part { return Agent.output(output) }
    }
    return nil
  }

  // MARK: sending

  /// Sends text. The one way to advance a conversation, with `send(_: ClientTurn)`.
  public func send(_ text: String) async {
    await send(ClientTurn(text: text))
  }

  /// Sends a turn. Answers to pending calls may travel with text.
  public func send(_ turn: ClientTurn) async {
    await start(turn).value
  }

  /// Starts a turn and returns the task streaming it. Everything up to the
  /// request going out happens before this returns, which is what lets
  /// `approve` coalesce and `stop` see the turn it is stopping.
  @discardableResult
  private func start(_ turn: ClientTurn) -> Task<Void, Never> {
    // One run at a time. A second send while the first streams is a user who
    // changed their mind; the superseded turn is marked aborted as it is cut.
    let superseded = inFlight
    superseded?.task.cancel()
    let clientRunId = localId()

    if let superseded {
      // Cancelling closes the connection, and that no longer stops a run, so
      // the superseded one is stopped by the handles that name exactly it —
      // never by `threadId`, which may already name the run this turn starts.
      var stopBody: JSONObject = [:]
      if let runId = state.runId { stopBody["runId"] = .string(runId) }
      if let id = superseded.clientRunId { stopBody["clientRunId"] = .string(id) }
      if !stopBody.isEmpty {
        // Not awaited, and a failure is only reported without a thread: with
        // one, the server ends the old run when this turn reaches it.
        let report: (AgentError) -> Void =
          state.threadId == nil ? { [weak self] in self?.onError?($0) } : { _ in }
        Task { await self.postStop(stopBody, report: report) }
      }
      state.markAborted()
    }

    let history = state.messages
    var authored: [AgentMessage] = []
    if turn.text?.isEmpty == false || !turn.files.isEmpty {
      var content: [JSONValue] = []
      if let text = turn.text, !text.isEmpty {
        content.append(["type": "text", "text": .string(text)])
      }
      for file in turn.files {
        var part = file.json
        part["type"] = "file"
        content.append(.object(part))
      }
      authored.append(
        AgentMessage(json: [
          "id": .string(localId()), "role": "user", "content": .array(content),
          "createdAt": .string(ChatState.timestamp()),
        ]))
    }
    state.messages = history + authored
    // The error belonged to the attempt being retried, and every pending call
    // is settled by this turn — the server denies whatever it left out.
    state.error = nil
    state.pending = []
    phase = .submitted

    var payload: JSONObject = ["turn": turn.json, "clientRunId": .string(clientRunId)]
    if let threadId = state.threadId {
      payload["threadId"] = .string(threadId)
    } else {
      payload["messages"] = .array(forWire(history).map { .object($0.json) })
    }
    payload.merge(body) { _, extra in extra }

    let id = UUID()
    let task = Task { [weak self] in
      guard let self else { return }
      defer { self.finish(id) }
      do {
        let response = try await self.post("", payload)
        if !response.isSuccess {
          self.fail(await httpError(response))
          return
        }
        try await self.consume(response)
      } catch {
        // A cancellation is `stop()`, a superseding send, or the session going
        // away; each has already put the UI where it belongs.
        if !Task.isCancelled, !(error is CancellationError) {
          self.fail(
            AgentError(code: "unknown", message: error.localizedDescription, retryable: true))
        }
      }
    }
    inFlight = InFlight(id: id, task: task, clientRunId: clientRunId)
    return task
  }

  private func finish(_ id: UUID) {
    guard inFlight?.id == id else { return }
    inFlight = nil
    phase = .idle
  }

  private func consume(_ response: ChatResponse) async throws {
    var decoder = SSEFrameDecoder()
    for try await chunk in response.body {
      for frame in decoder.push(chunk) { if !apply(frame) { return } }
    }
    for frame in decoder.flush() { if !apply(frame) { return } }
  }

  /// One frame into the state, and the callbacks it earns. `false` once the
  /// task is cancelled: a token landing after the user pressed stop is worse
  /// than one that never arrives.
  private func apply(_ frame: StreamFrame) -> Bool {
    if Task.isCancelled { return false }
    phase = .streaming
    let before = state
    // A replayed frame changes nothing and fires nothing.
    guard state.apply(frame) else { return true }

    let event = frame.event
    switch event["type"]?.stringValue {
    case "message-end":
      // Only for a message that was not already finished: a run replayed onto
      // a restored transcript must not have an app persist a message twice.
      let id = event["messageId"]?.stringValue
      if let message = state.messages.first(where: { $0.id == id }),
        before.messages.first(where: { $0.id == id })?.finishReason == nil
      {
        onFinish?(message)
      }
    case "awaiting-input":
      onAwaitingInput?(state.pending)
    case "error":
      if let error = event["error"]?.objectValue { onError?(AgentError(json: error)) }
    default:
      break
    }
    return true
  }

  /// A failure reported without touching the conversation. `pending`
  /// survives: most of what fails here has nothing to do with the question
  /// the conversation is holding, and its calls carry the only signatures that
  /// can answer it.
  private func fail(_ error: AgentError) {
    state.error = error
    onError?(error)
  }

  // MARK: answering

  /// Approves or refuses a pending call. Answers given in the same main-actor
  /// turn — a loop over `pending` — go out as one turn, because a turn that
  /// leaves a call unanswered refuses it.
  @discardableResult
  public func approve(_ toolCallId: String, _ approve: Bool, reason: String? = nil) -> Task<
    Void, Never
  > {
    guard let call = pendingCall(toolCallId) else { return Task {} }
    return queue(
      .approval(
        toolCallId: toolCallId, signature: call.signature, path: call.path, approve: approve,
        reason: reason))
  }

  /// Answers a `question` or `client` call with its output.
  @discardableResult
  public func answer(_ toolCallId: String, with output: some Encodable) -> Task<Void, Never> {
    guard let call = pendingCall(toolCallId) else { return Task {} }
    let value: JSONValue
    do {
      value = try JSONValue(encoding: output)
    } catch {
      fail(
        AgentError(
          code: "invalid_tool_result", message: "\(error)", retryable: false, toolCallId: toolCallId
        ))
      return Task {}
    }
    return queue(
      .output(toolCallId: toolCallId, signature: call.signature, path: call.path, output: value))
  }

  /// `answer`, with the answer's type fixed by the tool's schema.
  @discardableResult
  public func answer<Input, Output>(_ call: TypedPendingCall<Input, Output>, with output: Output)
    -> Task<Void, Never>
  {
    answer(call.toolCallId, with: output)
  }

  /// `approve`, for a typed pending call.
  @discardableResult
  public func approve<Input, Output>(
    _ call: TypedPendingCall<Input, Output>, _ approve: Bool, reason: String? = nil
  ) -> Task<Void, Never> {
    self.approve(call.toolCallId, approve, reason: reason)
  }

  private func pendingCall(_ toolCallId: String) -> PendingToolCall? {
    let matches = state.pending.filter { $0.toolCallId == toolCallId }
    guard matches.count == 1, let call = matches.first else {
      // No call, or two sub-runs holding calls with the same id. Refusing beats
      // guessing: picking one would approve a tool the user was not looking at.
      fail(
        AgentError(
          code: "invalid_tool_result",
          message: matches.isEmpty
            ? "No pending tool call \(toolCallId)"
            : "Ambiguous tool call \(toolCallId): \(matches.count) pending calls share it",
          retryable: false, toolCallId: toolCallId))
      return nil
    }
    return call
  }

  private func queue(_ result: ClientToolResult) -> Task<Void, Never> {
    if var queued {
      queued.results.append(result)
      self.queued = queued
      return queued.flush
    }
    let flush = Task { [weak self] in
      // Runs after the main actor finishes the code that queued this — the
      // same place the web hook's microtask lands.
      guard let self, let results = self.queued?.results else { return }
      self.queued = nil
      await self.send(ClientTurn(toolResults: results))
    }
    queued = ([result], flush)
    return flush
  }

  // MARK: stopping

  /// Cancels the turn. The UI stops now — the interrupted message stays,
  /// marked aborted — and the server is told, which is what actually ends the
  /// generation and any tool mid-flight.
  public func stop() async {
    let runId = state.runId
    let threadId = state.threadId
    let current = inFlight
    current?.task.cancel()
    inFlight = nil
    state.markAborted()
    phase = .idle
    // Gated on the request, not on `runId`: the seconds before `run-start` are
    // the ones a user is most likely to cancel in.
    if current == nil, runId == nil { return }
    var stopBody: JSONObject = [:]
    if let runId { stopBody["runId"] = .string(runId) }
    if let threadId { stopBody["threadId"] = .string(threadId) }
    if let id = current?.clientRunId { stopBody["clientRunId"] = .string(id) }
    await postStop(stopBody) { [weak self] in self?.fail($0) }
  }

  private func postStop(_ stopBody: JSONObject, report: (AgentError) -> Void) async {
    do {
      let response = try await post("/stop", stopBody)
      if !response.isSuccess { report(await httpError(response)) }
    } catch {
      if error is CancellationError { return }
      report(AgentError(code: "unknown", message: error.localizedDescription, retryable: true))
    }
  }

  // MARK: the rest

  /// Drops the last assistant turn and re-runs from the user turn before it.
  public func regenerate() async {
    guard
      let assistant = state.messages.lastIndex(where: { $0.role == .assistant }),
      let user = state.messages[..<assistant].lastIndex(where: { $0.role == .user })
    else { return }
    let turn = turnFrom(state.messages[user])
    // The user turn goes too, because `send` re-appends it.
    state.messages = Array(state.messages[..<user])
    state.pending = []
    state.error = nil
    await send(turn)
  }

  /// Replaces the transcript, e.g. with a thread re-read after `onAttachMiss`.
  public func setMessages(_ messages: [AgentMessage]) {
    state.messages = messages
  }

  /// Uploads through the agent's own `/files` route. Put `upload.file` in a
  /// turn's `files` to show the model the file; `upload.attachmentId` is the
  /// handle a tool fetches it by.
  public func upload(_ data: Data, name: String, mimeType: String) async throws -> ChatUpload {
    let boundary = "gemi-\(UUID().uuidString)"
    var form = Data()
    form.append(Data("--\(boundary)\r\n".utf8))
    // Escaped as `FormData` escapes it: a quote would end the filename early,
    // and a line break would start a header of the file's own choosing.
    let filename = name.replacingOccurrences(of: "\"", with: "%22")
      .replacingOccurrences(of: "\r", with: "%0D")
      .replacingOccurrences(of: "\n", with: "%0A")
    let disposition = "Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n"
    form.append(Data(disposition.utf8))
    form.append(Data("Content-Type: \(mimeType)\r\n\r\n".utf8))
    form.append(data)
    form.append(Data("\r\n--\(boundary)--\r\n".utf8))

    var request = URLRequest(url: endpoint.appendingPathComponent("files"))
    request.httpMethod = "POST"
    for (key, value) in try await headers() { request.setValue(value, forHTTPHeaderField: key) }
    request.setValue(
      "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.httpBody = form

    let response = try await transport.send(request)
    guard response.isSuccess else {
      let error = await httpError(response)
      fail(error)
      throw error
    }
    let result = JSONValue.parse(try await response.data())
    // Both ids passed through as they came, and neither required: which one a
    // file has is the server's policy. The name and type are already here.
    return ChatUpload(
      fileId: result?["fileId"]?.stringValue,
      attachmentId: result?["attachmentId"]?.stringValue,
      name: result?["name"]?.stringValue ?? name,
      mimeType: result?["mimeType"]?.stringValue ?? mimeType,
      downgraded: result?["downgraded"]?.stringValue)
  }

  /// Asks whether a run is still going on the thread and picks it up from the
  /// cursor. Done by `init` when `attach` is on.
  private func attachToRun(threadId: String) {
    var attachBody: JSONObject = [
      "threadId": .string(threadId), "cursor": .number(Double(state.seq)),
    ]
    if let runId = state.cursorRunId { attachBody["runId"] = .string(runId) }
    let id = UUID()
    let task = Task { [weak self] in
      guard let self else { return }
      defer { self.finish(id) }
      do {
        let response = try await self.post("/attach", attachBody)
        // Nothing running is the ordinary answer, and on more than one
        // instance also what a refresh routed away from its run gets.
        guard response.isSuccess, response.statusCode != 204 else {
          self.onAttachMiss?(threadId)
          return
        }
        try await self.consume(response)
      } catch {
        // A probe that could not be made leaves the session where one without
        // `attach` would be.
      }
    }
    // No `clientRunId`: this client did not start the run.
    inFlight = InFlight(id: id, task: task, clientRunId: nil)
  }

  private func post(_ path: String, _ payload: JSONObject) async throws -> ChatResponse {
    var request = URLRequest(url: path.isEmpty ? endpoint : endpoint.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    for (key, value) in try await headers() { request.setValue(value, forHTTPHeaderField: key) }
    request.httpBody = try JSONValue.object(payload).jsonData()
    return try await transport.send(request)
  }
}

/// A session with no generated schema: every view is the raw part.
public typealias UntypedChatSession = ChatSession<UntypedAgent>

// MARK: - helpers

/// Ids this client mints. Prefixed so they cannot collide with the server's,
/// and so a server log can tell which end invented one.
func localId() -> String {
  "local_\(UUID().uuidString.lowercased())"
}

/// An HTTP failure before the stream started, in the stream's error shape.
func httpError(_ response: ChatResponse) async -> AgentError {
  var message = "Request failed with status \(response.statusCode)"
  var code = response.statusCode == 429 ? "rate_limited" : "unknown"
  if let data = try? await response.data(), let json = JSONValue.parse(data) {
    message = json["error"]?["message"]?.stringValue ?? json["message"]?.stringValue ?? message
    // The one server code an app can act on: the thread it holds is gone.
    if json["error"]?["code"]?.stringValue == "thread_not_found" { code = "thread_not_found" }
  }
  return AgentError(
    code: code, message: message,
    retryable: response.statusCode == 429 || response.statusCode >= 500)
}

func turnFrom(_ message: AgentMessage) -> ClientTurn {
  var text = ""
  var files: [ChatFile] = []
  for part in message.content {
    switch part {
    case .text(let value): text += value
    case .file(let file):
      files.append(ChatFile(fileId: file.fileId, name: file.name, mimeType: file.mimeType))
    default: break
    }
  }
  return ClientTurn(text: text.isEmpty ? nil : text, files: files)
}

/// The history as the server needs it: without `progress`, which nothing
/// server-side reads and which a stateless client would otherwise upload again
/// on every turn. `nested` is kept, recursed into, because the resume path
/// replays a sub-agent from it.
func forWire(_ messages: [AgentMessage]) -> [AgentMessage] {
  messages.map { message in
    guard let content = message.json["content"]?.arrayValue,
      content.contains(where: {
        $0["type"]?.stringValue == "tool-call" && ($0["progress"] != nil || $0["nested"] != nil)
      })
    else { return message }
    var json = message.json
    json["content"] = .array(
      content.map { value in
        guard var part = value.objectValue, part["type"]?.stringValue == "tool-call" else {
          return value
        }
        part["progress"] = nil
        if let runs = part["nested"]?.arrayValue {
          part["nested"] = .array(
            runs.map { run in
              guard var run = run.objectValue else { return run }
              let messages = (run["messages"]?.arrayValue ?? []).map {
                AgentMessage(json: $0.objectValue ?? [:])
              }
              run["messages"] = .array(forWire(messages).map { .object($0.json) })
              return .object(run)
            })
        }
        return .object(part)
      })
    return AgentMessage(json: json)
  }
}
