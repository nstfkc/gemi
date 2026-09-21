import Foundation

/// One turn from the client: text, files, answers to pending calls, or any
/// mix. `types.ts` `ClientTurn`.
///
/// A turn that leaves a pending call unanswered denies it — the provider
/// rejects a history with a dangling tool call — so answers to several calls
/// belong in one turn, which is what `ChatSession.approve` and `answer` arrange.
public struct ClientTurn: Sendable, Hashable {
  public var text: String?
  public var files: [ChatFile]
  public var toolResults: [ClientToolResult]

  public init(text: String? = nil, files: [ChatFile] = [], toolResults: [ClientToolResult] = []) {
    self.text = text
    self.files = files
    self.toolResults = toolResults
  }

  var json: JSONValue {
    var json: JSONObject = [:]
    if let text { json["text"] = .string(text) }
    if !files.isEmpty { json["files"] = .array(files.map { .object($0.json) }) }
    if !toolResults.isEmpty { json["toolResults"] = .array(toolResults.map(\.json)) }
    return .object(json)
  }
}

/// An uploaded file, as `ChatSession.upload` returns it and a turn carries it.
public struct ChatFile: Sendable, Hashable {
  public var fileId: String
  public var name: String?
  public var mimeType: String?

  public init(fileId: String, name: String? = nil, mimeType: String? = nil) {
    self.fileId = fileId
    self.name = name
    self.mimeType = mimeType
  }

  var json: JSONObject {
    var json: JSONObject = ["fileId": .string(fileId)]
    if let name { json["name"] = .string(name) }
    if let mimeType { json["mimeType"] = .string(mimeType) }
    return json
  }
}

/// What `ChatSession.upload` returns: the two handles the server may give a
/// file, either of which can be absent.
///
/// `fileId` is the provider's — what goes in a turn's `files`, and what the
/// model is shown. `attachmentId` is gemi's — the handle a tool fetches the
/// bytes by, which an app passes to the agent in its own words or payload. A
/// file the server kept but never sent to the provider has no `fileId`; an
/// upload the server had no scope to keep has no `attachmentId`. See
/// `AgentController.attachmentScope`.
public struct ChatUpload: Sendable, Hashable {
  public var fileId: String?
  public var attachmentId: String?
  public var name: String
  public var mimeType: String
  /// Set when the server wanted to keep the file and had no scope to keep it
  /// under — a missing `attachmentId` that is a misconfigured route rather
  /// than the app's policy. `"no_scope"` today.
  public var downgraded: String?

  public init(
    fileId: String? = nil, attachmentId: String? = nil, name: String, mimeType: String,
    downgraded: String? = nil
  ) {
    self.fileId = fileId
    self.attachmentId = attachmentId
    self.name = name
    self.mimeType = mimeType
    self.downgraded = downgraded
  }

  /// The file to put in a turn's `files`, when the provider has it.
  public var file: ChatFile? {
    fileId.map { ChatFile(fileId: $0, name: name, mimeType: mimeType) }
  }
}

/// The client's half of a pending call. `types.ts` `ClientToolResult`.
///
/// `signature` and `path` are the pending call's, handed back untouched: the
/// server signed them, and they are what stop an answer being applied to a
/// call — or an input — it was not given for. `ChatSession` fills them in; an
/// app answers by id.
public enum ClientToolResult: Sendable, Hashable {
  case approval(
    toolCallId: String, signature: String, path: [String]?, approve: Bool, reason: String?)
  /// For `question` and `client` calls: the value itself, checked against the
  /// tool's output schema on the server before the model sees it.
  case output(toolCallId: String, signature: String, path: [String]?, output: JSONValue)

  var json: JSONValue {
    var json: JSONObject
    switch self {
    case .approval(let toolCallId, let signature, let path, let approve, let reason):
      json = [
        "toolCallId": .string(toolCallId), "signature": .string(signature),
        "approve": .bool(approve),
      ]
      if let path { json["path"] = .array(path.map(JSONValue.string)) }
      if let reason { json["reason"] = .string(reason) }
    case .output(let toolCallId, let signature, let path, let output):
      json = [
        "toolCallId": .string(toolCallId), "signature": .string(signature), "output": output,
      ]
      if let path { json["path"] = .array(path.map(JSONValue.string)) }
    }
    return .object(json)
  }
}
