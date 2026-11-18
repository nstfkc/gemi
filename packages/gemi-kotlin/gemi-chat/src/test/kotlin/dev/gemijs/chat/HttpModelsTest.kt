package dev.gemijs.chat

import dev.gemijs.chat.generated.PATCHNotesIdError
import dev.gemijs.chat.generated.PATCHNotesIdErrorKind
import dev.gemijs.chat.generated.PATCHNotesIdErrorStatus
import dev.gemijs.chat.generated.PATCHNotesIdInput
import dev.gemijs.chat.generated.PATCHNotesIdParams
import dev.gemijs.chat.generated.PATCHNotesIdResponse
import dev.gemijs.chat.generated.POSTNotesError
import dev.gemijs.chat.generated.POSTNotesErrorGone
import dev.gemijs.chat.generated.POSTNotesInput
import dev.gemijs.chat.generated.POSTNotesInputState
import dev.gemijs.chat.generated.POSTNotesInputWireVersion2
import dev.gemijs.chat.generated.POSTNotesResponse
import dev.gemijs.chat.generated.POSTNotesResponseTrue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonPrimitive

class HttpModelsTest {
  @Test
  fun updateNoteModelsMatchTheRoute() {
    val params = PATCHNotesIdParams(id = "n1")
    val body = PATCHNotesIdInput(title = "Milk")
    assertEquals("""{"title":"Milk"}""", GemiJson.encodeToString(PATCHNotesIdInput.serializer(), body))

    val response = GemiJson.decodeFromString<PATCHNotesIdResponse>("""{"id":"n1","title":"Milk"}""")
    assertEquals(params.id, response.id)
    assertEquals(body.title, response.title)

    val wire = """{"kind":"empty_title","status":422}"""
    val error = GemiJson.decodeFromString<PATCHNotesIdError>(wire)
    assertEquals(PATCHNotesIdErrorKind, error.kind)
    assertEquals(PATCHNotesIdErrorStatus, error.status)
    assertEquals(error, GemiJson.decodeFromString<PATCHNotesIdError>(GemiJson.encodeToString(PATCHNotesIdError.serializer(), error)))
    for (other in listOf("""{"kind":"gone","status":422}""", """{"kind":"empty_title","status":410}""")) {
      assertFailsWith<SerializationException> { GemiJson.decodeFromString<PATCHNotesIdError>(other) }
    }
  }

  @Test
  fun createNoteModelsMatchTheRoute() {
    val body = POSTNotesInput(note = null, wireVersion2 = POSTNotesInputWireVersion2, state = POSTNotesInputState.Open)
    assertEquals(
      GemiJson.parseToJsonElement("""{"note":null,"wire-version":2.5,"wireVersion":true,"state":"open"}"""),
      GemiJson.encodeToJsonElement(POSTNotesInput.serializer(), body),
    )
    val wire = """{"ok":true,"tag":null,"createdAt":"2026-11-19"}"""
    val result = GemiJson.decodeFromString<POSTNotesResponse>(wire)
    val note = result as POSTNotesResponseTrue
    assertEquals(null, note.tag)
    assertEquals(JsonPrimitive("2026-11-19"), note.createdAt)
    assertEquals(GemiJson.parseToJsonElement(wire), GemiJson.encodeToJsonElement(POSTNotesResponse.serializer(), result))
    assertFailsWith<SerializationException> {
      GemiJson.decodeFromString<POSTNotesResponse>("""{"ok":"true","tag":null,"createdAt":null}""")
    }
    assertEquals(POSTNotesErrorGone(), GemiJson.decodeFromString<POSTNotesError>("""{"kind":"gone","status":410}"""))
    assertFailsWith<SerializationException> {
      GemiJson.decodeFromString<POSTNotesError>("""{"kind":"gone"}""")
    }
  }
}
