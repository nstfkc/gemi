package dev.gemijs.chat

import dev.gemijs.chat.generated.Classifier
import dev.gemijs.chat.generated.SupportAgent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

// The files in `generated/` are `gemi ai:generate-client --platform kotlin`
// output for the fixture agents in `packages/gemi/bin/ai-client/__fixtures__`,
// checked in so this source set compiles them against the runtime they target.
// A vitest test fails when they drift from what the generator writes.

private fun json(text: String): JsonObject = GemiJson.parseToJsonElement(text).jsonObject

class GeneratedSchemaTest {
  @Test
  fun aToolCallNarrowsToItsTypedInput() {
    val part = ContentPart.ToolCall(json("""{"type":"tool-call","toolCallId":"tc_1","name":"grep","input":{"pattern":"TODO","filePath":"a.ts"}}"""))
    val call = assertIs<SupportAgent.ToolCall.Grep>(SupportAgent.toolCall(part)).value
    assertEquals(SupportAgent.GrepInput(pattern = "TODO", filePath = "a.ts"), call.input)
    assertEquals("tc_1", call.toolCallId)
  }

  @Test
  fun progressDecodesThroughTheDiscriminatedUnion() {
    val part =
      ContentPart.ToolCall(
        json(
          """{"type":"tool-call","toolCallId":"tc_2","name":"bash","input":{"command":"ls"},"progress":[{"stage":"started","pid":42},{"stage":"line","text":"a.ts","stream":"stdout"},{"stage":"exploded"}]}"""
        )
      )
    val call = assertIs<SupportAgent.ToolCall.Bash>(SupportAgent.toolCall(part)).value
    // The third entry is a stage this file does not know: left out of the
    // typed list, kept in the raw one.
    assertEquals(
      listOf(
        SupportAgent.BashProgressStarted(stage = "started", pid = 42.0),
        SupportAgent.BashProgressLine(stage = "line", text = "a.ts", stream = SupportAgent.BashProgressLineStream.Stdout),
      ),
      call.progress,
    )
    assertEquals(3, call.part.progress.size)
  }

  @Test
  fun aPartialCallHasNoInputYet() {
    val part = ContentPart.ToolCall(json("""{"type":"tool-call","toolCallId":"tc_3","name":"grep","input":{"pattern":"TO"},"partial":true}"""))
    val call = assertIs<SupportAgent.ToolCall.Grep>(SupportAgent.toolCall(part)).value
    assertNull(call.input)
    assertTrue(call.part.partial)
  }

  @Test
  fun aResultDecodesItsOutcome() {
    val paid =
      ContentPart.ToolResult(
        json("""{"type":"tool-result","toolCallId":"tc_4","name":"charge","status":"ok","output":{"status":"paid","receiptId":"rc_1"}}""")
      )
    val result = assertIs<SupportAgent.ToolResult.Charge>(SupportAgent.toolResult(paid)).value
    assertEquals(TypedToolResult.Outcome.Ok(SupportAgent.ChargeOutputPaid(status = "paid", receiptId = "rc_1")), result.outcome)

    val denied =
      ContentPart.ToolResult(
        json("""{"type":"tool-result","toolCallId":"tc_5","name":"charge","status":"denied","cause":"refused","reason":"too much"}""")
      )
    val refusal = assertIs<SupportAgent.ToolResult.Charge>(SupportAgent.toolResult(denied)).value
    assertEquals(TypedToolResult.Outcome.Denied("refused", "too much"), refusal.outcome)
  }

  @Test
  fun anythingTheFileDoesNotKnowIsUnknownRatherThanAFailure() {
    val newTool = ContentPart.ToolCall(json("""{"type":"tool-call","toolCallId":"tc_6","name":"brandNew","input":{}}"""))
    assertEquals(SupportAgent.ToolCall.Unknown(newTool), SupportAgent.toolCall(newTool))

    val drifted =
      ContentPart.ToolResult(
        json("""{"type":"tool-result","toolCallId":"tc_7","name":"grep","status":"ok","output":{"matches":"not a list"}}""")
      )
    assertEquals(SupportAgent.ToolResult.Unknown(drifted), SupportAgent.toolResult(drifted))
  }

  @Test
  fun aSnakeCaseToolIsAPascalCaseClass() {
    val part = ContentPart.ToolCall(json("""{"type":"tool-call","toolCallId":"tc_8","name":"refund_order","input":{"orderId":"o_1"}}"""))
    val call = assertIs<SupportAgent.ToolCall.RefundOrder>(SupportAgent.toolCall(part)).value
    assertEquals("o_1", call.input?.orderId)
  }

  @Test
  fun aPendingQuestionCarriesTheSerializerOfItsAnswer() {
    val pending =
      PendingToolCall(
        json("""{"toolCallId":"tc_9","name":"ask","input":{"question":"Which order?"},"kind":"question","signature":"sig"}""")
      )
    val call = assertIs<SupportAgent.Pending.Ask>(SupportAgent.pending(pending)).value
    assertEquals("Which order?", call.input?.question)
    assertEquals(
      buildJsonObject { put("answer", "March") },
      GemiJson.encodeToJsonElement(call.output, SupportAgent.AskOutput(answer = "March")),
    )
  }

  @Test
  fun aRequiredNullableKeyIsWrittenAsNullAndAnOptionalOneIsLeftOut() {
    val input = SupportAgent.ChargeInput(amountCents = 500.0, currency = SupportAgent.ChargeInputCurrency.Try, reason = null)
    val encoded = GemiJson.encodeToJsonElement(SupportAgent.ChargeInput.serializer(), input).jsonObject
    // `reason` is `.nullable()` on the server, so it must be present;
    // `metadata` is `.optional()`, so it must not.
    assertEquals(JsonNull, encoded["reason"])
    assertTrue("metadata" !in encoded)
    assertEquals(JsonPrimitive("try"), encoded["currency"])
  }

  @Test
  fun aUnionEncodesAsItsVariant() {
    val output: SupportAgent.ChargeOutput = SupportAgent.ChargeOutputDeclined(status = "declined", declineCode = "insufficient", retryable = true)
    val encoded = GemiJson.encodeToJsonElement(SupportAgent.ChargeOutput.serializer(), output)
    assertEquals(json("""{"status":"declined","declineCode":"insufficient","retryable":true}"""), encoded)
    assertEquals(output, GemiJson.decodeFromJsonElement(SupportAgent.ChargeOutput.serializer(), encoded))
  }

  @Test
  fun aStructuredOutputDecodesOnceItIsWhole() {
    val partial = ContentPart.Output(json("""{"type":"output","value":{"sentiment":"positive"},"partial":true}"""))
    assertNull(Classifier.output(partial))

    val whole = ContentPart.Output(json("""{"type":"output","value":{"sentiment":"negative","topics":["billing"]}}"""))
    assertEquals(
      Classifier.StructuredOutput(sentiment = Classifier.StructuredOutputSentiment.Negative, topics = listOf("billing")),
      Classifier.output(whole),
    )
  }
}
