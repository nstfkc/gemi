import Foundation
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
  #expect(error.kind == .value)
  #expect(error.status == .value)
  #expect(try decoder.decode(PATCHNotesIdError.self, from: JSONEncoder().encode(error)) == error)
  for other in [#"{"kind":"gone","status":422}"#, #"{"kind":"empty_title","status":410}"#] {
    #expect(throws: DecodingError.self) {
      try decoder.decode(PATCHNotesIdError.self, from: Data(other.utf8))
    }
  }
}
