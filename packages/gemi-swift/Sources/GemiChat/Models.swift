import Foundation

// The message model of `ai/types.ts`, as typed views over JSON.
//
// Each type here holds the object the server sent (`json`) and reads its
// fields off it, rather than decoding into stored properties. `JSONValue.swift`
// says why: the transcript is posted back verbatim, and a member this file does
// not know about must survive the trip. Where `types.ts` has a union of string
// literals, the Swift side is a `RawRepresentable` struct rather than an enum,
// for the same reason — a server one release ahead sends a reason this client
// has never heard of, and that must decode, not throw.

/// Why a message or a run stopped. `types.ts` `FinishReason`.
public struct FinishReason: RawRepresentable, Hashable, Sendable, Codable,
  ExpressibleByStringLiteral
{
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(stringLiteral value: String) { self.rawValue = value }

  public static let stop: FinishReason = "stop"
  public static let length: FinishReason = "length"
  /// `maxSteps` was hit. Not an error, and not a finished answer either.
  public static let maxSteps: FinishReason = "max-steps"
  /// The run is over and the conversation is holding a question.
  public static let awaitingInput: FinishReason = "awaiting-input"
  public static let aborted: FinishReason = "aborted"
  public static let error: FinishReason = "error"
}

public struct Usage: Hashable, Sendable, Codable {
  public var inputTokens: Int
  public var outputTokens: Int
  public var reasoningTokens: Int?
  public var cachedInputTokens: Int?
  public var totalTokens: Int

  public init(
    inputTokens: Int, outputTokens: Int, reasoningTokens: Int? = nil,
    cachedInputTokens: Int? = nil, totalTokens: Int
  ) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.reasoningTokens = reasoningTokens
    self.cachedInputTokens = cachedInputTokens
    self.totalTokens = totalTokens
  }
}

/// A view over a JSON object. Everything below is one.
public protocol JSONObjectView: Hashable, Sendable, Codable {
  var json: JSONObject { get }
  init(json: JSONObject)
}

extension JSONObjectView {
  public init(from decoder: Decoder) throws {
    self.init(json: try JSONObject(from: decoder))
  }

  public func encode(to encoder: Encoder) throws {
    try json.encode(to: encoder)
  }

  func string(_ key: String) -> String? { json[key]?.stringValue }
}

public struct AgentError: JSONObjectView, Error {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(code: String, message: String, retryable: Bool, toolCallId: String? = nil) {
    var json: JSONObject = [
      "code": .string(code), "message": .string(message), "retryable": .bool(retryable),
    ]
    if let toolCallId { json["toolCallId"] = .string(toolCallId) }
    self.json = json
  }

  /// `types.ts` `AgentErrorCode`, e.g. `"rate_limited"` or `"thread_not_found"`.
  public var code: String { string("code") ?? "unknown" }
  public var message: String { string("message") ?? "" }
  public var toolCallId: String? { string("toolCallId") }
  public var retryable: Bool { json["retryable"]?.boolValue ?? false }
}

public struct AgentMessage: JSONObjectView, Identifiable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public struct Role: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public static let system: Role = "system"
    public static let user: Role = "user"
    public static let assistant: Role = "assistant"
  }

  public var id: String { string("id") ?? "" }
  public var role: Role { Role(rawValue: string("role") ?? "assistant") }
  public var content: [ContentPart] {
    (json["content"]?.arrayValue ?? []).map { ContentPart(json: $0.objectValue ?? [:]) }
  }
  public var createdAt: String { string("createdAt") ?? "" }
  /// Absent while the message is still streaming.
  public var finishReason: FinishReason? {
    string("finishReason").map { FinishReason(rawValue: $0) }
  }
  public var usage: Usage? { json["usage"].flatMap { try? $0.decode(as: Usage.self) } }

  /// The text parts joined, which is what most UIs render as the message body.
  public var text: String {
    content.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined()
  }
}

/// One part of a message. `types.ts` `AgentContentPart`.
public enum ContentPart: Hashable, Sendable {
  case text(String)
  case reasoning(ReasoningPart)
  case file(FilePart)
  case toolCall(ToolCallPart)
  case toolResult(ToolResultPart)
  case output(OutputPart)
  /// A part type this client does not know — a newer server. Kept so it
  /// renders as nothing rather than failing the message.
  case unknown(JSONObject)

  public init(json: JSONObject) {
    switch json["type"]?.stringValue {
    case "text": self = .text(json["text"]?.stringValue ?? "")
    case "reasoning": self = .reasoning(ReasoningPart(json: json))
    case "file": self = .file(FilePart(json: json))
    case "tool-call": self = .toolCall(ToolCallPart(json: json))
    case "tool-result": self = .toolResult(ToolResultPart(json: json))
    case "output": self = .output(OutputPart(json: json))
    default: self = .unknown(json)
    }
  }
}

public struct ReasoningPart: JSONObjectView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
  public var id: String? { string("id") }
  public var text: String? { string("text") }
}

public struct FilePart: JSONObjectView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
  /// The provider's file id: what the model is shown.
  public var fileId: String { string("fileId") ?? "" }
  public var name: String? { string("name") }
  public var mimeType: String? { string("mimeType") }
  /// gemi's attachment id, when there is one — the handle a tool fetches the
  /// bytes by. Set on a file a tool showed the model, and on an upload the
  /// server kept.
  public var attachmentId: String? { string("attachmentId") }
}

public struct ToolCallPart: JSONObjectView, Identifiable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
  public var id: String { toolCallId }
  public var toolCallId: String { string("toolCallId") ?? "" }
  public var name: String { string("name") ?? "" }
  public var input: JSONValue { json["input"] ?? .null }
  /// Set while the model is still streaming the arguments, so `input` may be
  /// missing members its type requires.
  public var partial: Bool { json["partial"]?.boolValue ?? false }
  /// Everything the tool yielded, in order.
  public var progress: [JSONValue] { json["progress"]?.arrayValue ?? [] }
  /// Sub-agent runs this tool drove, in the order they started.
  public var nested: [NestedRun] {
    (json["nested"]?.arrayValue ?? []).map { NestedRun(json: $0.objectValue ?? [:]) }
  }
  /// What this call parked with `ctx.attachments.put`, in order — the
  /// server's memo, kept as it sent it.
  public var attachments: [JSONValue] { json["attachments"]?.arrayValue ?? [] }
}

public struct ToolResultPart: JSONObjectView, Identifiable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
  public var id: String { toolCallId }
  public var toolCallId: String { string("toolCallId") ?? "" }
  public var name: String { string("name") ?? "" }

  public enum Outcome: Hashable, Sendable {
    case ok(JSONValue)
    case error(AgentError)
    /// The call did not run: `"refused"` by the client, or `"stopped"` by a
    /// cancel that landed while it was in flight.
    case denied(cause: String, reason: String?)
  }

  public var outcome: Outcome {
    switch string("status") {
    case "error": .error(AgentError(json: json["error"]?.objectValue ?? [:]))
    case "denied": .denied(cause: string("cause") ?? "refused", reason: string("reason"))
    default: .ok(json["output"] ?? .null)
    }
  }
}

/// The final answer of an agent with an `output` schema.
public struct OutputPart: JSONObjectView {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
  public var value: JSONValue { json["value"] ?? .null }
  /// True while the object is still being assembled from the token stream.
  public var partial: Bool { json["partial"]?.boolValue ?? false }
}

/// A sub-agent's run, recorded on the tool call that drove it. Its `messages`
/// are an ordinary transcript, so whatever renders a chat renders this too.
public struct NestedRun: JSONObjectView, Identifiable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }
  public var id: String { runId }
  public var runId: String { string("runId") ?? "" }
  public var agent: String { string("agent") ?? "" }
  public var label: String? { string("label") }
  public var messages: [AgentMessage] {
    (json["messages"]?.arrayValue ?? []).map { AgentMessage(json: $0.objectValue ?? [:]) }
  }
  public var finishReason: FinishReason? {
    string("finishReason").map { FinishReason(rawValue: $0) }
  }
  public var usage: Usage? { json["usage"].flatMap { try? $0.decode(as: Usage.self) } }
}

/// A tool call the server will not complete on its own. `types.ts`
/// `PendingToolCall`.
public struct PendingToolCall: JSONObjectView, Identifiable {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public struct Kind: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    /// The server can run it, but not without a person saying yes.
    public static let approval: Kind = "approval"
    /// The whole answer is the person's.
    public static let question: Kind = "question"
    /// Only the app can run it.
    public static let client: Kind = "client"
  }

  public var id: String { toolCallId }
  public var toolCallId: String { string("toolCallId") ?? "" }
  public var name: String { string("name") ?? "" }
  public var input: JSONValue { json["input"] ?? .null }
  public var kind: Kind { Kind(rawValue: string("kind") ?? "question") }
  /// Handed back untouched with the answer.
  public var signature: String { string("signature") ?? "" }
  /// The chain of tool calls a sub-agent's question is nested under,
  /// outermost first. Handed back untouched; read it only to say who is asking.
  public var path: [String]? { json["path"]?.arrayValue?.compactMap(\.stringValue) }
}
