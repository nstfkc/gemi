// Generated from bin/http-client/__fixtures__/notes.ts#default. Do not edit.
import Foundation
import GemiChat

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

  public init(
    kind: PATCHNotesIdErrorKind = .emptyTitle,
    status: PATCHNotesIdErrorStatus = ._422
  ) {
    self.kind = kind
    self.status = status
  }
}

public struct POSTNotesInput: Codable, Hashable, Sendable {
  public var note: String?
  public var title: String?
  public var wireVersion: POSTNotesInputWireVersion
  public var wireVersion2: POSTNotesInputWireVersion2?
  public var state: POSTNotesInputState?

  public init(
    note: String? = nil,
    title: String? = nil,
    wireVersion: POSTNotesInputWireVersion = ._25,
    wireVersion2: POSTNotesInputWireVersion2? = nil,
    state: POSTNotesInputState? = nil
  ) {
    self.note = note
    self.title = title
    self.wireVersion = wireVersion
    self.wireVersion2 = wireVersion2
    self.state = state
  }

  private enum CodingKeys: String, CodingKey {
    case note
    case title
    case wireVersion = "wire-version"
    case wireVersion2 = "wireVersion"
    case state
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(self.note, forKey: .note)
    try container.encodeIfPresent(self.title, forKey: .title)
    try container.encode(self.wireVersion, forKey: .wireVersion)
    try container.encodeIfPresent(self.wireVersion2, forKey: .wireVersion2)
    try container.encodeIfPresent(self.state, forKey: .state)
  }
}

public enum POSTNotesInputState: String, Codable, Hashable, Sendable, CaseIterable {
  case `open`
  case closed
}

public enum POSTNotesResponse: Codable, Hashable, Sendable {
  case `true`(POSTNotesResponseTrue)
  case `false`(POSTNotesResponseFalse)

  private enum Discriminant: String, CodingKey {
    case key = "ok"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Discriminant.self)
    let value = try container.decode(Bool.self, forKey: .key)
    switch value {
    case true: self = .true(try POSTNotesResponseTrue(from: decoder))
    case false: self = .false(try POSTNotesResponseFalse(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .true(let value): try value.encode(to: encoder)
    case .false(let value): try value.encode(to: encoder)
    }
  }
}

public struct POSTNotesResponseTrue: Codable, Hashable, Sendable {
  public var ok: POSTNotesResponseTrueOk
  public var tag: POSTNotesResponseTrueTag?
  public var createdAt: JSONValue

  public init(
    ok: POSTNotesResponseTrueOk = .`true`,
    tag: POSTNotesResponseTrueTag? = nil,
    createdAt: JSONValue
  ) {
    self.ok = ok
    self.tag = tag
    self.createdAt = createdAt
  }

  private enum CodingKeys: String, CodingKey {
    case ok
    case tag
    case createdAt
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(self.ok, forKey: .ok)
    try container.encode(self.tag, forKey: .tag)
    try container.encode(self.createdAt, forKey: .createdAt)
  }
}

public struct POSTNotesResponseFalse: Codable, Hashable, Sendable {
  public var ok: POSTNotesResponseFalseOk
  public var tag: POSTNotesResponseFalseTag?

  public init(ok: POSTNotesResponseFalseOk = .`false`, tag: POSTNotesResponseFalseTag? = nil) {
    self.ok = ok
    self.tag = tag
  }

  private enum CodingKeys: String, CodingKey {
    case ok
    case tag
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(self.ok, forKey: .ok)
    try container.encode(self.tag, forKey: .tag)
  }
}

public enum POSTNotesError: Codable, Hashable, Sendable {
  case emptyTitle(POSTNotesErrorEmptyTitle)
  case gone(POSTNotesErrorGone)

  private enum Discriminant: String, CodingKey {
    case key = "kind"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Discriminant.self)
    let value = try container.decode(String.self, forKey: .key)
    switch value {
    case "empty_title": self = .emptyTitle(try POSTNotesErrorEmptyTitle(from: decoder))
    case "gone": self = .gone(try POSTNotesErrorGone(from: decoder))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .key, in: container, debugDescription: "Unknown kind \"\(value)\"")
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .emptyTitle(let value): try value.encode(to: encoder)
    case .gone(let value): try value.encode(to: encoder)
    }
  }
}

public struct POSTNotesErrorEmptyTitle: Codable, Hashable, Sendable {
  public var kind: POSTNotesErrorEmptyTitleKind
  public var status: POSTNotesErrorEmptyTitleStatus

  public init(
    kind: POSTNotesErrorEmptyTitleKind = .emptyTitle,
    status: POSTNotesErrorEmptyTitleStatus = ._422
  ) {
    self.kind = kind
    self.status = status
  }
}

public struct POSTNotesErrorGone: Codable, Hashable, Sendable {
  public var kind: POSTNotesErrorGoneKind
  public var status: POSTNotesErrorGoneStatus

  public init(kind: POSTNotesErrorGoneKind = .gone, status: POSTNotesErrorGoneStatus = ._410) {
    self.kind = kind
    self.status = status
  }
}

public enum PATCHNotesIdErrorKind: Codable, Hashable, Sendable {
  case emptyTitle

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == "empty_title" else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected PATCHNotesIdErrorKind")
    }
    self = .emptyTitle
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode("empty_title" as String)
  }
}

public enum PATCHNotesIdErrorStatus: Codable, Hashable, Sendable {
  case _422

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Double.self) == 422 else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected PATCHNotesIdErrorStatus")
    }
    self = ._422
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(422 as Double)
  }
}

public enum POSTNotesInputWireVersion: Codable, Hashable, Sendable {
  case _25

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Double.self) == 2.5 else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesInputWireVersion")
    }
    self = ._25
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(2.5 as Double)
  }
}

public enum POSTNotesInputWireVersion2: Codable, Hashable, Sendable {
  case `true`

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Bool.self) == true else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesInputWireVersion2")
    }
    self = .`true`
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(true as Bool)
  }
}

public enum POSTNotesResponseTrueOk: Codable, Hashable, Sendable {
  case `true`

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Bool.self) == true else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesResponseTrueOk")
    }
    self = .`true`
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(true as Bool)
  }
}

public enum POSTNotesResponseTrueTag: Codable, Hashable, Sendable {
  case saved

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == "saved" else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesResponseTrueTag")
    }
    self = .saved
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode("saved" as String)
  }
}

public enum POSTNotesResponseFalseOk: Codable, Hashable, Sendable {
  case `false`

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Bool.self) == false else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesResponseFalseOk")
    }
    self = .`false`
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(false as Bool)
  }
}

public enum POSTNotesResponseFalseTag: Codable, Hashable, Sendable {
  case saved

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == "saved" else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesResponseFalseTag")
    }
    self = .saved
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode("saved" as String)
  }
}

public enum POSTNotesErrorEmptyTitleKind: Codable, Hashable, Sendable {
  case emptyTitle

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == "empty_title" else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesErrorEmptyTitleKind")
    }
    self = .emptyTitle
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode("empty_title" as String)
  }
}

public enum POSTNotesErrorEmptyTitleStatus: Codable, Hashable, Sendable {
  case _422

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Double.self) == 422 else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesErrorEmptyTitleStatus")
    }
    self = ._422
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(422 as Double)
  }
}

public enum POSTNotesErrorGoneKind: Codable, Hashable, Sendable {
  case gone

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == "gone" else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesErrorGoneKind")
    }
    self = .gone
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode("gone" as String)
  }
}

public enum POSTNotesErrorGoneStatus: Codable, Hashable, Sendable {
  case _410

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(Double.self) == 410 else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unexpected POSTNotesErrorGoneStatus")
    }
    self = ._410
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(410 as Double)
  }
}
