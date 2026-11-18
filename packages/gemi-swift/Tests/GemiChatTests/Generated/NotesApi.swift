// Generated from bin/http-client/__fixtures__/notes.ts#default. Do not edit.
import Foundation

public struct PATCHNotesIdParams: Codable, Hashable, Sendable {
  public var id: String

  public init(id: String) {
    self.id = id
  }
}

public struct PATCHNotesIdInput: Codable, Hashable, Sendable {
  public var title: String

  public init(title: String) {
    self.title = title
  }
}

public struct PATCHNotesIdResponse: Codable, Hashable, Sendable {
  public var id: String
  public var title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}

public struct PATCHNotesIdError: Codable, Hashable, Sendable {
  public var kind: PATCHNotesIdErrorKind
  public var status: PATCHNotesIdErrorStatus

  public init(kind: PATCHNotesIdErrorKind, status: PATCHNotesIdErrorStatus) {
    self.kind = kind
    self.status = status
  }
}

public enum PATCHNotesIdErrorKind: Codable, Hashable, Sendable {
  case value

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == "empty_title" else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected PATCHNotesIdErrorKind")
    }
    self = .value
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode("empty_title" as String)
  }
}

public enum PATCHNotesIdErrorStatus: Codable, Hashable, Sendable {
  case value

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Double.self) == 422 else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected PATCHNotesIdErrorStatus")
    }
    self = .value
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(422 as Double)
  }
}
