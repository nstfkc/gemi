import Foundation
import Testing

@testable import GemiChat

// The TypeScript reducer's and decoder's tests, replayed.
//
// `packages/gemi/ai/client/__fixtures__` holds every call those tests make
// with what it returned, and this port passes when it gives the same answer to
// every one. There is deliberately no second list of scenarios here: see the
// README beside the fixtures.

private let fixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()  // GemiChatTests
  .deletingLastPathComponent()  // Tests
  .deletingLastPathComponent()  // gemi-swift
  .deletingLastPathComponent()  // packages
  .appendingPathComponent("gemi/ai/client/__fixtures__")

private func corpus(_ name: String) throws -> [JSONObject] {
  let data = try Data(contentsOf: fixtures.appendingPathComponent(name))
  let file = try #require(JSONValue.parse(data)?.objectValue)
  #expect(file["version"] == 1)
  return try #require(file["cases"]?.arrayValue).compactMap(\.objectValue)
}

@Test func reducerMatchesTheTypeScriptReducer() throws {
  let cases = try corpus("reducer.json")
  #expect(cases.count > 100)

  for (index, entry) in cases.enumerated() {
    let label = "case \(index): \(entry.string("test") ?? "") [\(entry.string("op") ?? "")]"
    let expected = entry["result"]
    switch entry.string("op") {
    case "initialChatState":
      let state = ChatState(initializing: entry["init"]?.objectValue)
      expectSame(state.fixtureJSON, expected, label)

    case "applyFrame":
      var state = try ChatState(fixture: #require(entry["state"]?.objectValue))
      let frame = try #require(entry["frame"]?.objectValue)
      let applied = state.apply(
        StreamFrame(seq: try #require(frame["seq"]?.intValue), event: frame["event"] ?? .null),
        now: try #require(entry.string("now")))
      expectSame(state.fixtureJSON, expected, label)
      #expect(applied == !(entry["unchanged"]?.boolValue ?? false), "\(label): applied")

    case "markAborted":
      var state = try ChatState(fixture: #require(entry["state"]?.objectValue))
      state.markAborted()
      expectSame(state.fixtureJSON, expected, label)

    default:
      Issue.record("\(label): unknown op")
    }
  }
}

@Test func decoderMatchesTheTypeScriptDecoder() throws {
  let cases = try corpus("sse.json")
  #expect(cases.count > 5)

  for (index, entry) in cases.enumerated() {
    var decoder = SSEFrameDecoder()
    for (step, call) in (entry["calls"]?.arrayValue ?? []).enumerated() {
      let label = "case \(index) step \(step): \(entry.string("test") ?? "")"
      let frames: [StreamFrame]
      if let push = call["push"] {
        if let text = push["text"]?.stringValue {
          frames = decoder.push(text)
        } else {
          let bytes = try #require(Data(base64Encoded: push["bytes"]?.stringValue ?? ""))
          frames = decoder.push(bytes)
        }
      } else {
        frames = decoder.flush()
      }
      let json = JSONValue.array(
        frames.map { ["seq": .number(Double($0.seq)), "event": $0.event] })
      expectSame(json, call["frames"], label)
      #expect(decoder.cursor == call["cursor"]?.intValue, "\(label): cursor")
    }
  }
}

/// Reports a mismatch as the path to the first difference and the two values
/// there. A whole `ChatState` printed twice is unreadable.
private func expectSame(
  _ actual: JSONValue, _ expected: JSONValue?, _ label: String,
  sourceLocation: SourceLocation = #_sourceLocation
) {
  guard let difference = firstDifference(actual, expected ?? .null, at: "$") else { return }
  Issue.record("\(label)\n\(difference)", sourceLocation: sourceLocation)
}

private func firstDifference(_ actual: JSONValue, _ expected: JSONValue, at path: String)
  -> String?
{
  switch (actual, expected) {
  case (.object(let a), .object(let e)):
    for key in Set(a.keys).union(e.keys).sorted() {
      switch (a[key], e[key]) {
      case (let x?, let y?):
        if let found = firstDifference(x, y, at: "\(path).\(key)") { return found }
      case (let x?, nil): return "\(path).\(key): unexpected \(compact(x))"
      case (nil, let y?): return "\(path).\(key): missing, expected \(compact(y))"
      case (nil, nil): break
      }
    }
    return nil
  case (.array(let a), .array(let e)):
    for index in 0..<min(a.count, e.count) {
      if let found = firstDifference(a[index], e[index], at: "\(path)[\(index)]") { return found }
    }
    return a.count == e.count ? nil : "\(path): \(a.count) elements, expected \(e.count)"
  default:
    return actual == expected
      ? nil : "\(path): got \(compact(actual)), expected \(compact(expected))"
  }
}

private func compact(_ value: JSONValue) -> String {
  (try? value.jsonData()).map { String(decoding: $0, as: UTF8.self) } ?? "?"
}

// MARK: - ChatState as the TypeScript side writes it

extension ChatState {
  /// `initialChatState(init)`, read off the fixture's argument.
  init(initializing arguments: JSONObject?) {
    let arguments = arguments ?? [:]
    self.init(
      messages: (arguments["messages"]?.arrayValue ?? []).map {
        AgentMessage(json: $0.objectValue ?? [:])
      },
      pending: (arguments["pending"]?.arrayValue ?? []).map {
        PendingToolCall(json: $0.objectValue ?? [:])
      },
      threadId: arguments["threadId"]?.stringValue,
      seq: arguments["seq"]?.intValue,
      cursorRunId: arguments["cursorRunId"]?.stringValue
    )
  }

  /// A whole recorded state, including the members `init` does not take.
  init(fixture json: JSONObject) throws {
    self.init(initializing: json)
    seq = try #require(json["seq"]?.intValue)
    error = json["error"]?.objectValue.map(AgentError.init(json:))
    runId = json["runId"]?.stringValue
    runMessageIds = (json["runMessageIds"]?.arrayValue ?? []).compactMap(\.stringValue)
    loadedTools = (json["loadedTools"]?.arrayValue ?? []).compactMap(\.stringValue)
    finishReason = json["finishReason"]?.stringValue.map { FinishReason(rawValue: $0) }
  }

  /// The state as `JSON.stringify` writes the TypeScript one: `undefined`
  /// members absent, `error` present as `null`.
  var fixtureJSON: JSONValue {
    var json: JSONObject = [
      "messages": .array(messages.map { .object($0.json) }),
      "pending": .array(pending.map { .object($0.json) }),
      "error": error.map { .object($0.json) } ?? .null,
      "seq": .number(Double(seq)),
      "runMessageIds": .array(runMessageIds.map(JSONValue.string)),
      "loadedTools": .array(loadedTools.map(JSONValue.string)),
    ]
    json["runId"] = runId.map(JSONValue.string)
    json["threadId"] = threadId.map(JSONValue.string)
    json["cursorRunId"] = cursorRunId.map(JSONValue.string)
    json["finishReason"] = finishReason.map { .string($0.rawValue) }
    return .object(json)
  }
}
