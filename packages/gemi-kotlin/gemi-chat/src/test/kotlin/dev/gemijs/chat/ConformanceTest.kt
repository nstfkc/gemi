package dev.gemijs.chat

import java.io.File
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The TypeScript reducer's and decoder's tests, replayed.
//
// `packages/gemi/ai/client/__fixtures__` holds every call those tests make
// with what it returned, and this port passes when it gives the same answer to
// every one. There is deliberately no second list of scenarios here: see the
// README beside the fixtures.

/** Gradle runs a module's tests from the module's directory. */
private val fixtures = File("../../gemi/ai/client/__fixtures__")

private fun corpus(name: String): List<JsonObject> {
  val file = GemiJson.parseToJsonElement(File(fixtures, name).readText()).obj()!!
  assertEquals(1, file["version"].int())
  return file["cases"].array()!!.map { it.obj()!! }
}

class ConformanceTest {
  @Test
  fun reducerMatchesTheTypeScriptReducer() {
    val cases = corpus("reducer.json")
    assertTrue(cases.size > 100)
    val failures = mutableListOf<String>()

    cases.forEachIndexed { index, entry ->
      val label = "case $index: ${entry.string("test")} [${entry.string("op")}]"
      val expected = entry["result"]
      when (entry.string("op")) {
        "initialChatState" -> expectSame(initializing(entry["init"].obj()).fixtureJson(), expected, label, failures)
        "applyFrame" -> {
          val state = fixture(entry["state"].obj()!!)
          val frame = entry["frame"].obj()!!
          val next = state.apply(StreamFrame(frame["seq"].int()!!, frame["event"] ?: JsonNull), entry.string("now")!!)
          expectSame((next ?: state).fixtureJson(), expected, label, failures)
          val unchanged = entry["unchanged"].bool() ?: false
          if ((next == null) != unchanged) failures += "$label: applied should be ${!unchanged}"
        }
        "markAborted" -> expectSame(fixture(entry["state"].obj()!!).markAborted().fixtureJson(), expected, label, failures)
        else -> failures += "$label: unknown op"
      }
    }
    if (failures.isNotEmpty()) fail("${failures.size} of ${cases.size} cases differ:\n${failures.take(10).joinToString("\n")}")
  }

  @Test
  fun decoderMatchesTheTypeScriptDecoder() {
    val cases = corpus("sse.json")
    assertTrue(cases.size > 5)
    val failures = mutableListOf<String>()

    cases.forEachIndexed { index, entry ->
      val decoder = SSEFrameDecoder()
      entry["calls"].array().orEmpty().forEachIndexed { step, value ->
        val call = value.obj()!!
        val label = "case $index step $step: ${entry.string("test")}"
        val push = call["push"].obj()
        val frames =
          when {
            push == null -> decoder.flush()
            push["text"] != null -> decoder.push(push.string("text")!!)
            else -> decoder.push(Base64.getDecoder().decode(push.string("bytes")!!))
          }
        val json = JsonArray(frames.map { jsonObjectOf("seq" to JsonPrimitive(it.seq), "event" to it.event) })
        expectSame(json, call["frames"], label, failures)
        if (decoder.cursor != call["cursor"].int()) failures += "$label: cursor ${decoder.cursor}, expected ${call["cursor"]}"
      }
    }
    if (failures.isNotEmpty()) fail("${failures.size} steps differ:\n${failures.take(10).joinToString("\n")}")
  }
}

/** Records the path to the first difference, rather than two whole states. */
private fun expectSame(actual: JsonElement, expected: JsonElement?, label: String, failures: MutableList<String>) {
  firstDifference(actual, expected ?: JsonNull, "$")?.let { failures += "$label\n  $it" }
}

private fun firstDifference(actual: JsonElement, expected: JsonElement, path: String): String? =
  when {
    actual is JsonObject && expected is JsonObject ->
      (actual.keys + expected.keys).sorted().firstNotNullOfOrNull { key ->
        val a = actual[key]
        val e = expected[key]
        when {
          a == null -> "$path.$key: missing, expected $e"
          e == null -> "$path.$key: unexpected $a"
          else -> firstDifference(a, e, "$path.$key")
        }
      }
    actual is JsonArray && expected is JsonArray ->
      actual.indices.take(expected.size).firstNotNullOfOrNull { firstDifference(actual[it], expected[it], "$path[$it]") }
        ?: if (actual.size != expected.size) "$path: ${actual.size} elements, expected ${expected.size}" else null
    else -> if (jsonEquals(actual, expected)) null else "$path: got $actual, expected $expected"
  }

/** `initialChatState(init)`, read off the fixture's argument. */
private fun initializing(init: JsonObject?): ChatState {
  val args = init ?: JsonObject(emptyMap())
  return ChatState.initial(
    messages = args["messages"].array().orEmpty().map { AgentMessage(it.obj()!!) },
    pending = args["pending"].array().orEmpty().map { PendingToolCall(it.obj()!!) },
    threadId = args.string("threadId"),
    seq = args["seq"].int(),
    cursorRunId = args.string("cursorRunId"),
  )
}

/** A whole recorded state. */
private fun fixture(json: JsonObject): ChatState =
  initializing(json).copy(
    seq = json["seq"].int()!!,
    error = json["error"].obj()?.let(::AgentError),
    runId = json.string("runId"),
    runMessageIds = json["runMessageIds"].array().orEmpty().mapNotNull { it.string() },
    loadedTools = json["loadedTools"].array().orEmpty().mapNotNull { it.string() },
    finishReason = json.string("finishReason")?.let(::FinishReason),
  )

/** The state as `JSON.stringify` writes the TypeScript one. */
private fun ChatState.fixtureJson(): JsonObject =
  jsonObjectOf(
    "messages" to JsonArray(messages.map { it.json }),
    "pending" to JsonArray(pending.map { it.json }),
    "error" to (error?.json ?: JsonNull),
    "seq" to JsonPrimitive(seq),
    "runMessageIds" to JsonArray(runMessageIds.map(::JsonPrimitive)),
    "loadedTools" to JsonArray(loadedTools.map(::JsonPrimitive)),
    "runId" to runId.json(),
    "threadId" to threadId.json(),
    "cursorRunId" to cursorRunId.json(),
    "finishReason" to finishReason?.value.json(),
  )
