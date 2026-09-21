import Foundation
import Testing

@testable import GemiChat

// The typed views over a transcript. The corpus compares raw JSON, so it never
// reads a message through them; a misspelled discriminator would only show up
// here.

private let message = AgentMessage(json: [
  "id": "m1", "role": "assistant", "createdAt": "2026-09-21T00:00:00.000Z",
  "finishReason": "stop",
  "usage": ["inputTokens": 3, "outputTokens": 4, "totalTokens": 7],
  "content": [
    ["type": "reasoning", "id": "r1", "text": "thinking"],
    ["type": "text", "text": "Hello, "],
    ["type": "file", "fileId": "f1", "name": "a.png", "mimeType": "image/png"],
    ["type": "tool-call", "toolCallId": "c1", "name": "lookup", "input": ["q": "x"]],
    ["type": "tool-result", "toolCallId": "c1", "name": "lookup", "output": 42],
    ["type": "output", "value": ["ok": true], "partial": true],
    ["type": "text", "text": "world"],
    ["type": "citation", "url": "https://example.com"],
  ],
])

@Test func aMessageReadsItsParts() {
  #expect(message.id == "m1")
  #expect(message.role == .assistant)
  #expect(message.finishReason == .stop)
  #expect(message.usage == Usage(inputTokens: 3, outputTokens: 4, totalTokens: 7))
  #expect(message.text == "Hello, world")

  let parts = message.content
  #expect(parts.count == 8)
  guard case .reasoning(let reasoning) = parts[0] else {
    Issue.record("\(parts[0])")
    return
  }
  #expect(reasoning.id == "r1" && reasoning.text == "thinking")
  #expect(parts[1] == .text("Hello, "))
  guard case .file(let file) = parts[2] else {
    Issue.record("\(parts[2])")
    return
  }
  #expect(file.fileId == "f1" && file.mimeType == "image/png" && file.attachmentId == nil)
  guard case .toolCall(let call) = parts[3] else {
    Issue.record("\(parts[3])")
    return
  }
  #expect(call.id == "c1" && call.name == "lookup" && call.input == ["q": "x"] && !call.partial)
  guard case .toolResult(let result) = parts[4] else {
    Issue.record("\(parts[4])")
    return
  }
  #expect(result.outcome == .ok(42))
  guard case .output(let output) = parts[5] else {
    Issue.record("\(parts[5])")
    return
  }
  #expect(output.value == ["ok": true] && output.partial)
  // A part from a newer server is kept whole, and posted back as it came.
  #expect(parts[7] == .unknown(["type": "citation", "url": "https://example.com"]))
}

@Test func aToolResultSaysHowTheCallEnded() {
  let error = ToolResultPart(json: [
    "toolCallId": "c1", "status": "error",
    "error": ["code": "tool_failed", "message": "boom", "retryable": true],
  ])
  #expect(
    error.outcome == .error(AgentError(code: "tool_failed", message: "boom", retryable: true)))

  let refused = ToolResultPart(json: ["toolCallId": "c1", "status": "denied"])
  #expect(refused.outcome == .denied(cause: "refused", reason: nil))

  let stopped = ToolResultPart(json: [
    "toolCallId": "c1", "status": "denied", "cause": "stopped", "reason": "cancelled",
  ])
  #expect(stopped.outcome == .denied(cause: "stopped", reason: "cancelled"))

  // No status is the success the server sends: `output` alone.
  #expect(ToolResultPart(json: ["toolCallId": "c1"]).outcome == .ok(.null))
}

@Test func missingMembersFallBackToTheirDefaults() {
  let empty = AgentMessage(json: [:])
  #expect(empty.id == "" && empty.role == .assistant && empty.content.isEmpty)
  #expect(empty.finishReason == nil && empty.usage == nil && empty.text == "")

  let pending = PendingToolCall(json: ["toolCallId": "c1", "path": ["outer", "inner"]])
  #expect(pending.kind == .question && pending.signature == "" && pending.input == .null)
  #expect(pending.path == ["outer", "inner"])
  #expect(PendingToolCall(json: ["kind": "approval"]).kind == .approval)

  #expect(AgentError(json: [:]).code == "unknown")
  #expect(AgentError(json: [:]).retryable == false)
  // A reason this client has never heard of still decodes.
  #expect(AgentMessage(json: ["finishReason": "paused"]).finishReason?.rawValue == "paused")
}

@Test func aViewEncodesAsTheObjectItWasGiven() throws {
  let data = try JSONEncoder().encode(message)
  #expect(JSONValue.parse(data) == .object(message.json))
  #expect(try JSONDecoder().decode(AgentMessage.self, from: data) == message)
}
