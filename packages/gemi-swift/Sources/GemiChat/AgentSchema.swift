import Foundation

/// An agent's tool and output types, as `gemi ai:generate-client` writes them.
///
/// The transcript stays JSON (see `JSONValue`); a schema is how a UI reads it
/// typed. `SupportAgent.toolCall(part)` turns a raw part into
/// `.grep(TypedToolCall<GrepInput, Never>)`, which a `switch` narrows exactly
/// as `part.name === "grep"` narrows the TypeScript union.
///
/// Every view has an `.unknown` case, because the server is not obliged to
/// match the generated file: a tool added since the last generate, a skill
/// (lowered to a tool the agent's types never list), or a part whose payload no
/// longer decodes all land there instead of failing the message.
public protocol AgentSchema: Sendable {
  associatedtype ToolCall: Sendable, Hashable
  associatedtype ToolResult: Sendable, Hashable
  associatedtype Pending: Sendable, Hashable
  /// The agent's structured final answer; `Never` for an agent without one.
  associatedtype Output: Codable, Sendable, Hashable

  static func toolCall(_ part: ToolCallPart) -> ToolCall
  static func toolResult(_ part: ToolResultPart) -> ToolResult
  static func pending(_ call: PendingToolCall) -> Pending
}

extension AgentSchema {
  /// The typed final answer, once it parses. A partial snapshot usually does
  /// not — required members are still missing — so this is `nil` until it
  /// does, and `part.value` has what has arrived so far.
  public static func output(_ part: OutputPart) -> Output? {
    try? part.value.decode(as: Output.self)
  }
}

/// The schema of an agent nothing was generated for: every view is the raw
/// part.
public enum UntypedAgent: AgentSchema {
  public typealias Output = JSONValue
  public static func toolCall(_ part: ToolCallPart) -> ToolCallPart { part }
  public static func toolResult(_ part: ToolResultPart) -> ToolResultPart { part }
  public static func pending(_ call: PendingToolCall) -> PendingToolCall { call }
}

/// A tool call with its payloads decoded.
public struct TypedToolCall<
  Input: Decodable & Sendable & Hashable, Progress: Decodable & Sendable & Hashable
>:
  Sendable, Hashable, Identifiable
{
  public let part: ToolCallPart
  /// `nil` while the model is still streaming the arguments (`part.partial`)
  /// and they do not yet make a whole `Input`.
  public let input: Input?
  /// What the tool has yielded so far, in order. An entry that does not decode
  /// is left out; `part.progress` has every one raw.
  public let progress: [Progress]

  public init(_ part: ToolCallPart) {
    self.part = part
    self.input = try? part.input.decode(as: Input.self)
    self.progress = part.progress.compactMap { try? $0.decode(as: Progress.self) }
  }

  public var id: String { part.toolCallId }
  public var toolCallId: String { part.toolCallId }
  /// Sub-agent runs this call drove. Their tools are the sub-agent's, so their
  /// transcripts are untyped here, as they are in TypeScript.
  public var nested: [NestedRun] { part.nested }
}

/// A tool result with its output decoded.
public struct TypedToolResult<Output: Decodable & Sendable & Hashable>: Sendable, Hashable,
  Identifiable
{
  public enum Outcome: Sendable, Hashable {
    case ok(Output)
    case error(AgentError)
    /// The call did not run: `"refused"` by the client, or `"stopped"` by a
    /// cancel that landed while it was in flight.
    case denied(cause: String, reason: String?)
  }

  public let part: ToolResultPart
  public let outcome: Outcome

  /// `nil` when the result is `ok` but its output does not decode as `Output`.
  public init?(_ part: ToolResultPart) {
    self.part = part
    switch part.outcome {
    case .ok(let value):
      guard let output = try? value.decode(as: Output.self) else { return nil }
      outcome = .ok(output)
    case .error(let error): outcome = .error(error)
    case .denied(let cause, let reason): outcome = .denied(cause: cause, reason: reason)
    }
  }

  public var id: String { part.toolCallId }
  public var toolCallId: String { part.toolCallId }
}

/// A pending call with its input decoded, and the type of the answer it takes.
///
/// `Output` is what `ChatSession.answer(_:with:)` accepts for it — for a
/// question, the tool's output schema — so a wrong-shaped answer is a compile
/// error rather than the server's `invalid_tool_result`.
public struct TypedPendingCall<
  Input: Decodable & Sendable & Hashable, Output: Encodable & Sendable & Hashable
>:
  Sendable, Hashable, Identifiable
{
  /// What answering this call takes.
  public typealias Answer = Output

  public let call: PendingToolCall
  public let input: Input?

  public init(_ call: PendingToolCall) {
    self.call = call
    self.input = try? call.input.decode(as: Input.self)
  }

  public var id: String { call.toolCallId }
  public var toolCallId: String { call.toolCallId }
  public var kind: PendingToolCall.Kind { call.kind }
}
