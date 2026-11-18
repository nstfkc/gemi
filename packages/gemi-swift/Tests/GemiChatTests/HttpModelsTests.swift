import Foundation
import GemiChat
import Testing

@Test func updateNoteModelsMatchTheRoute() throws {
  let params = PATCHNotesIdParams(id: "n1")
  let body = PATCHNotesIdInput(title: "Milk")
  let decoder = JSONDecoder()
  let encoded = try JSONEncoder().encode(body)
  #expect(try decoder.decode([String: String].self, from: encoded) == ["title": "Milk"])

  let response = try decoder.decode(PATCHNotesIdResponse.self, from: Data(#"{"id":"n1","title":"Milk"}"#.utf8))
  #expect(response.id == params.id)
  #expect(response.title == body.title)

  let error = try decoder.decode(PATCHNotesIdError.self, from: Data(#"{"kind":"empty_title","status":422}"#.utf8))
  #expect(error.kind == .emptyTitle)
  #expect(error.status == ._422)
  #expect(try decoder.decode(PATCHNotesIdError.self, from: JSONEncoder().encode(error)) == error)
  for other in [#"{"kind":"gone","status":422}"#, #"{"kind":"empty_title","status":410}"#] {
    #expect(throws: DecodingError.self) {
      try decoder.decode(PATCHNotesIdError.self, from: Data(other.utf8))
    }
  }
}

@Test func createNoteModelsMatchTheRoute() throws {
  let decoder = JSONDecoder()
  let encoder = JSONEncoder()
  let body = POSTNotesInput(note: nil, wireVersion2: .true, state: .open)
  let encoded = try decoder.decode(JSONValue.self, from: encoder.encode(body))
  #expect(encoded == .object(["note": .null, "wire-version": .number(2.5),
                              "wireVersion": .bool(true), "state": .string("open")]))

  let wire = Data(#"{"ok":true,"tag":null,"createdAt":"2026-11-19"}"#.utf8)
  let result = try decoder.decode(POSTNotesResponse.self, from: wire)
  guard case .true(let note) = result else {
    Issue.record("Expected the success variant")
    return
  }
  #expect(note.tag == nil)
  #expect(note.createdAt == .string("2026-11-19"))
  #expect(try decoder.decode(JSONValue.self, from: encoder.encode(result)) == decoder.decode(JSONValue.self, from: wire))
  #expect(throws: DecodingError.self) {
    try decoder.decode(POSTNotesResponse.self, from: Data(#"{"ok":"true","tag":null,"createdAt":null}"#.utf8))
  }
  let gone = try decoder.decode(POSTNotesError.self, from: Data(#"{"kind":"gone","status":410}"#.utf8))
  #expect(gone == .gone(POSTNotesErrorGone()))
}
