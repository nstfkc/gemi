import Foundation

/// Frames to a message list. A port of `ai/client/reducer.ts`, held to every
/// call its tests make (`ai/client/__fixtures__/reducer.json`).
///
/// The rule it is built around: **a client may be handed any suffix of a run,
/// and may be handed the same frame twice.** So nothing tracks "the current
/// message"; every event names what it touches, `seq` refuses a redelivered
/// frame, and a finished message refuses a replayed delta. The TypeScript file
/// carries the long form of every decision below, and a change to one belongs
/// there first — the fixtures are regenerated from its tests.
///
/// Written over the raw JSON on purpose, as a close transliteration: the
/// fixtures pin the behaviour, but a reader checking the port against the
/// original should be able to put the two side by side.
public struct ChatState: Hashable, Sendable {
  public internal(set) var messages: [AgentMessage]
  /// Non-empty exactly while the conversation is holding a question.
  public internal(set) var pending: [PendingToolCall]
  public internal(set) var error: AgentError?
  /// Set while a run is live.
  public internal(set) var runId: String?
  public internal(set) var threadId: String?
  /// The highest frame applied: the cursor `/attach` resumes from.
  public internal(set) var seq: Int
  /// Which run `seq` counts within. Outlives the run, unlike `runId`.
  public internal(set) var cursorRunId: String?
  /// The messages the run in hand has touched, oldest first.
  public internal(set) var runMessageIds: [String]
  /// The deferred tools the model has loaded this run, as a set.
  public internal(set) var loadedTools: [String]
  public internal(set) var finishReason: FinishReason?

  /// `initialChatState`. `seq: -1` means "I have seen nothing".
  public init(
    messages: [AgentMessage] = [],
    pending: [PendingToolCall] = [],
    threadId: String? = nil,
    seq: Int? = nil,
    cursorRunId: String? = nil
  ) {
    self.messages = messages
    self.pending = pending
    self.error = nil
    self.threadId = threadId
    self.seq = seq ?? -1
    self.cursorRunId = cursorRunId
    self.runMessageIds = []
    self.loadedTools = []
  }

  /// Applies one frame. Returns `false` when the frame was a replay and
  /// nothing changed — the TypeScript reducer returning its input object — so
  /// a caller can skip the callbacks it would otherwise fire twice.
  @discardableResult
  public mutating func apply(_ frame: StreamFrame, now: String = ChatState.timestamp())
    -> Bool
  {
    let event = frame.event.objectValue ?? [:]
    // A `seq` numbers frames within one run, so a new run's `run-start` is the
    // one frame entitled to drop the cursor.
    let startsNewRun =
      event.string("type") == "run-start" && event["runId"] != cursorRunId.map(JSONValue.string)
    if !startsNewRun, frame.seq <= seq { return false }
    reduce(event, now: now)
    seq = frame.seq
    return true
  }

  /// `markAborted`: `stop()` calls this before the server has said anything.
  /// The interrupted turn stays, marked cut short; a pending question stays too.
  public mutating func markAborted() {
    runId = nil
    finishReason = .aborted
    messages = finishUnended(reason: .aborted)
  }

  public static func timestamp(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

// MARK: - reduce

extension ChatState {
  mutating func reduce(_ event: JSONObject, now: String) {
    switch event.string("type") {
    case "run-start":
      runId = event.string("runId")
      cursorRunId = event.string("runId")
      threadId = event.string("threadId") ?? threadId
      runMessageIds = []
      loadedTools = []
      finishReason = nil

    case "message-start":
      withMessage(event.string("messageId") ?? "", now: now) { message in
        message["role"] = event["role"]
      }

    case "text-delta":
      let id = event.string("messageId") ?? ""
      if isFinished(id) { return }
      withMessage(id, now: now) { message in
        message["content"] = .array(appendText(message.content, event.string("delta") ?? ""))
      }

    case "reasoning-delta":
      let id = event.string("messageId") ?? ""
      if isFinished(id) { return }
      withMessage(id, now: now) { message in
        message["content"] = .array(
          appendReasoning(message.content, event.string("delta") ?? "", id: event["id"]))
      }

    case "output-delta":
      // `snapshot` is the whole object so far; replacing beats accumulating.
      withMessage(event.string("messageId") ?? "", now: now) { message in
        var part: JSONObject = ["type": "output", "partial": true]
        part["value"] = event["snapshot"]
        message["content"] = .array(
          upsert(message.content, part) { $0.string("type") == "output" })
      }

    case "tool-call":
      // Merged, not replaced: `progress` and `nested` are the execution's
      // half of the part and arrive on events that name no message.
      let eventPart = event["part"]?.objectValue ?? [:]
      let toolCallId = eventPart["toolCallId"]
      withMessage(event.string("messageId") ?? "", now: now) { message in
        var content = message.content
        let index = content.firstIndex {
          $0.string("type") == "tool-call" && $0["toolCallId"] == toolCallId
        }
        let existing = index.map { content[$0] }
        var part = eventPart
        if let progress = nonNull(eventPart["progress"]) ?? nonNull(existing?["progress"]) {
          part["progress"] = progress
        }
        if let nested = nonNull(eventPart["nested"]) ?? nonNull(existing?["nested"]) {
          part["nested"] = nested
        }
        // The memo `ctx.attachments.put` replays from: a stateless client that
        // dropped it would have a re-entered tool store and upload its bytes
        // again.
        if let attachments = nonNull(eventPart["attachments"]) ?? nonNull(existing?["attachments"])
        {
          part["attachments"] = attachments
        }
        if let index { content[index] = .object(part) } else { content.append(.object(part)) }
        message["content"] = .array(content)
      }

    case "tool-search":
      // A set: union is the only accumulation that survives redelivery with
      // nothing to key it on.
      let loaded = (event["loaded"]?.arrayValue ?? []).compactMap(\.stringValue)
        .filter { !loadedTools.contains($0) }
      if loaded.isEmpty { return }
      loadedTools += loaded

    case "tool-progress":
      let data = event["data"] ?? .null
      withToolCall(event["toolCallId"]) { part in
        part["progress"] = .array((part["progress"]?.arrayValue ?? []) + [data])
      }

    case "nested-event":
      // The recursion: a sub-run's transcript is reduced by this same code.
      withToolCall(event["toolCallId"]) { part in
        var runs = part["nested"]?.arrayValue ?? []
        let index = runs.firstIndex { $0["runId"] == event["runId"] }
        var run: JSONObject = ["messages": []]
        run["runId"] = event["runId"]
        run["agent"] = event["agent"]
        if let index, let existing = runs[index].objectValue { run = existing }
        let next = JSONValue.object(ChatState.applyNested(run, event, now: now))
        if let index { runs[index] = next } else { runs.append(next) }
        part["nested"] = .array(runs)
      }

    case "tool-result":
      let eventPart = event["part"]?.objectValue ?? [:]
      let toolCallId = eventPart["toolCallId"]
      withMessage(event.string("messageId") ?? "", now: now) { message in
        message["content"] = .array(
          upsert(message.content, eventPart) {
            $0.string("type") == "tool-result" && $0["toolCallId"] == toolCallId
          })
      }
      // Answered, whoever answered it, so no longer pending.
      pending.removeAll { $0.json["toolCallId"] == toolCallId }

    case "message":
      // A whole message the server wrote — a tool's `showModel` file today —
      // replaced or appended by id. Its one author is the server and it is
      // complete when sent, so replacing loses nothing, and it is not created
      // through `withMessage`, which would make it an assistant's.
      guard let message = event["message"]?.objectValue else { return }
      let id = message["id"]
      if let index = messages.firstIndex(where: { $0.json["id"] == id }) {
        messages[index] = AgentMessage(json: message)
      } else {
        messages.append(AgentMessage(json: message))
      }
      let messageId = message.string("id") ?? ""
      if !runMessageIds.contains(messageId) { runMessageIds.append(messageId) }

    case "awaiting-input":
      runId = event.string("runId")
      pending = (event["pending"]?.arrayValue ?? []).map {
        PendingToolCall(json: $0.objectValue ?? [:])
      }

    case "message-end":
      withMessage(event.string("messageId") ?? "", now: now) { message in
        message["finishReason"] = event["finishReason"]
        message["content"] = .array(
          message.content.map { part in
            guard var closed = part.objectValue, closed.string("type") == "output",
              closed["partial"]?.boolValue == true
            else { return part }
            closed["partial"] = false
            return .object(closed)
          })
      }

    case "usage":
      // On the last assistant message, never on the user's own turn.
      guard let index = messages.lastIndex(where: { $0.json.string("role") == "assistant" })
      else { return }
      messages[index].json["usage"] = event["usage"]

    case "error":
      error = AgentError(json: event["error"]?.objectValue ?? [:])
      pending = []

    case "run-end":
      let reason = event.string("finishReason").map { FinishReason(rawValue: $0) }
      runId = nil
      finishReason = reason
      messages = finishUnended(reason: reason)

    default:
      // A newer server's event. Ignored, and the seq still advances.
      return
    }
  }

  /// A sub-run event applied to the sub-run's own transcript, through a state
  /// built for the purpose and thrown away.
  static func applyNested(_ run: JSONObject, _ event: JSONObject, now: String) -> JSONObject {
    var sub = ChatState.nested(messagesOf(run))
    sub.finishReason = run.string("finishReason").map { FinishReason(rawValue: $0) }
    let inner = event["event"]?.objectValue ?? [:]
    sub.reduce(inner, now: now)
    var next = run
    if let label = event["label"] { next["label"] = label }
    next["messages"] = .array(sub.messages.map { .object($0.json) })
    if let reason = sub.finishReason { next["finishReason"] = .string(reason.rawValue) }
    if inner.string("type") == "usage" { next["usage"] = inner["usage"] }
    return next
  }

  /// The state a nested transcript is reduced and closed through: every
  /// message is the run's own, and a sub-run's pending copy is never surfaced.
  static func nested(_ messages: [AgentMessage]) -> ChatState {
    var state = ChatState(messages: messages)
    state.runMessageIds = messages.map(\.id)
    return state
  }
}

// MARK: - closing a run

extension ChatState {
  /// This run's messages finished off with `reason` if they never ended, and
  /// the sub-runs inside them too.
  func finishUnended(reason: FinishReason?) -> [AgentMessage] {
    messages.map { message in
      message.json.string("role") == "assistant" && runMessageIds.contains(message.id)
        ? closeMessage(message, reason: reason) : message
    }
  }
}

private func closeMessage(_ message: AgentMessage, reason: FinishReason?) -> AgentMessage {
  var json = message.json
  let content = message.json["content"]?.arrayValue ?? []
  var changed = false
  let closed = content.map { value -> JSONValue in
    guard var part = value.objectValue, part.string("type") == "tool-call",
      let nested = part["nested"]?.arrayValue,
      nested.contains(where: { $0["finishReason"] == nil })
    else { return value }
    part["nested"] = .array(
      nested.map { run in
        run["finishReason"] == nil ? .object(closeRun(run.objectValue ?? [:], reason: reason)) : run
      })
    changed = true
    return .object(part)
  }
  if json["finishReason"] == nil {
    json["finishReason"] = reason.map { .string($0.rawValue) }
    json["content"] = .array(closed)
    return AgentMessage(json: json)
  }
  guard changed else { return message }
  json["content"] = .array(closed)
  return AgentMessage(json: json)
}

private func closeRun(_ run: JSONObject, reason: FinishReason?) -> JSONObject {
  let sub = ChatState.nested(messagesOf(run))
  var next = run
  next["finishReason"] = reason.map { .string($0.rawValue) }
  next["messages"] = .array(sub.finishUnended(reason: reason).map { .object($0.json) })
  return next
}

// MARK: - helpers

extension ChatState {
  /// Runs `update` over the tool-call part with this id, wherever it lives. A
  /// frame for a call this transcript does not have is dropped: inventing the
  /// call would need a name and an input the frame does not carry.
  mutating func withToolCall(_ toolCallId: JSONValue?, _ update: (inout JSONObject) -> Void) {
    for i in messages.indices.reversed() {
      let message = messages[i]
      var content = message.json["content"]?.arrayValue ?? []
      guard
        let index = content.firstIndex(where: {
          $0.string("type") == "tool-call" && $0["toolCallId"] == toolCallId
        })
      else { continue }
      // A finished message refuses the frame as replay — unless the run parked
      // on it and this call is still open, which is the resume turn.
      if message.json["finishReason"] != nil, !isReenterable(message, toolCallId) { return }
      var part = content[index].objectValue ?? [:]
      update(&part)
      content[index] = .object(part)
      messages[i].json["content"] = .array(content)
      if !runMessageIds.contains(message.id) { runMessageIds.append(message.id) }
      return
    }
  }

  func isReenterable(_ message: AgentMessage, _ toolCallId: JSONValue?) -> Bool {
    if message.json.string("finishReason") != FinishReason.awaitingInput.rawValue { return false }
    return !messages.contains { candidate in
      (candidate.json["content"]?.arrayValue ?? []).contains {
        $0.string("type") == "tool-result" && $0["toolCallId"] == toolCallId
      }
    }
  }

  func isFinished(_ messageId: String) -> Bool {
    guard let message = messages.first(where: { $0.id == messageId }) else { return false }
    return message.json["finishReason"] != nil
  }

  /// Updates the message with this id, creating it if the list never saw it
  /// start — the mid-stream attach.
  mutating func withMessage(
    _ messageId: String, now: String, _ update: (inout MessageDraft) -> Void
  ) {
    if !runMessageIds.contains(messageId) { runMessageIds.append(messageId) }
    if let index = messages.firstIndex(where: { $0.id == messageId }) {
      var draft = MessageDraft(json: messages[index].json)
      update(&draft)
      messages[index] = AgentMessage(json: draft.json)
    } else {
      var draft = MessageDraft(json: [
        "id": .string(messageId), "role": "assistant", "content": [], "createdAt": .string(now),
      ])
      update(&draft)
      messages.append(AgentMessage(json: draft.json))
    }
  }
}

/// A message being updated, with its content as raw part objects.
struct MessageDraft {
  var json: JSONObject

  subscript(key: String) -> JSONValue? {
    get { json[key] }
    set { json[key] = newValue }
  }

  var content: [JSONValue] { json["content"]?.arrayValue ?? [] }
}

private func messagesOf(_ run: JSONObject) -> [AgentMessage] {
  (run["messages"]?.arrayValue ?? []).map { AgentMessage(json: $0.objectValue ?? [:]) }
}

/// JavaScript's `??` treats `null` as missing too.
private func nonNull(_ value: JSONValue?) -> JSONValue? {
  guard let value, !value.isNull else { return nil }
  return value
}

/// Coalesced into the trailing text part only if it *is* trailing, so text
/// after a tool call opens a new part.
private func appendText(_ content: [JSONValue], _ delta: String) -> [JSONValue] {
  if let last = content.last?.objectValue, last.string("type") == "text" {
    return content.dropLast() + [
      ["type": "text", "text": .string((last.string("text") ?? "") + delta)]
    ]
  }
  return content + [["type": "text", "text": .string(delta)]]
}

/// Joins the last part only when the reasoning-item id matches, as
/// `appendReasoning` in `Agent.ts` does — a stateless client posts this back
/// and the provider matches on the id.
private func appendReasoning(_ content: [JSONValue], _ delta: String, id: JSONValue?)
  -> [JSONValue]
{
  if var last = content.last?.objectValue, last.string("type") == "reasoning", last["id"] == id {
    last["text"] = .string((last.string("text") ?? "") + delta)
    return content.dropLast() + [.object(last)]
  }
  if let id, truthy(id) {
    return content + [["type": "reasoning", "id": id, "text": .string(delta)]]
  }
  return content + [["type": "reasoning", "text": .string(delta)]]
}

private func truthy(_ value: JSONValue) -> Bool {
  switch value {
  case .null: false
  case .bool(let bool): bool
  case .number(let number): number != 0 && !number.isNaN
  case .string(let string): !string.isEmpty
  case .array, .object: true
  }
}

private func upsert(
  _ content: [JSONValue], _ part: JSONObject, where match: (JSONObject) -> Bool
) -> [JSONValue] {
  var next = content
  if let index = next.firstIndex(where: { match($0.objectValue ?? [:]) }) {
    next[index] = .object(part)
  } else {
    next.append(.object(part))
  }
  return next
}

extension Dictionary where Key == String, Value == JSONValue {
  func string(_ key: String) -> String? { self[key]?.stringValue }
}

extension JSONValue {
  fileprivate func string(_ key: String) -> String? { self[key]?.stringValue }
}
