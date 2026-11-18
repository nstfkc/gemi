package dev.gemijs.chat

import dev.gemijs.chat.generated.PATCHNotesIdError
import dev.gemijs.chat.generated.PATCHNotesIdErrorKind
import dev.gemijs.chat.generated.PATCHNotesIdErrorStatus
import dev.gemijs.chat.generated.PATCHNotesIdInput
import dev.gemijs.chat.generated.PATCHNotesIdParams
import dev.gemijs.chat.generated.PATCHNotesIdResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

class HttpModelsTest {
  @Test
  fun updateNoteModelsMatchTheRoute() {
    val params = PATCHNotesIdParams(id = "n1")
    val body = PATCHNotesIdInput(title = "Milk")
    assertEquals("""{"title":"Milk"}""", Json.encodeToString(PATCHNotesIdInput.serializer(), body))

    val response = Json.decodeFromString<PATCHNotesIdResponse>("""{"id":"n1","title":"Milk"}""")
    assertEquals(params.id, response.id)
    assertEquals(body.title, response.title)

    val wire = """{"kind":"empty_title","status":422}"""
    val error = Json.decodeFromString<PATCHNotesIdError>(wire)
    assertEquals(PATCHNotesIdErrorKind, error.kind)
    assertEquals(PATCHNotesIdErrorStatus, error.status)
    assertEquals(error, Json.decodeFromString<PATCHNotesIdError>(Json.encodeToString(PATCHNotesIdError.serializer(), error)))
    for (other in listOf("""{"kind":"gone","status":422}""", """{"kind":"empty_title","status":410}""")) {
      assertFailsWith<SerializationException> { Json.decodeFromString<PATCHNotesIdError>(other) }
    }
  }
}
