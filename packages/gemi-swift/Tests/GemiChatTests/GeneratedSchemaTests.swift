import Foundation
import Testing

@testable import GemiChat

// The files in `Generated/` are `gemi ai:generate-client` output for the
// fixture agents in `packages/gemi/bin/ai-client/__fixtures__`, checked in so
// this target compiles them against the runtime they target. A vitest test
// fails when they drift from what the generator writes.

private func json(_ text: String) -> JSONObject {
  JSONValue.parse(Data(text.utf8))!.objectValue!
}

@Test func aToolCallNarrowsToItsTypedInput() throws {
  let part = ToolCallPart(
    json: json(
      #"{"type":"tool-call","toolCallId":"tc_1","name":"grep","input":{"pattern":"TODO","filePath":"a.ts"}}"#
    ))
  guard case .grep(let call) = SupportAgent.toolCall(part) else {
    Issue.record("expected .grep")
    return
  }
  #expect(call.input == SupportAgent.GrepInput(pattern: "TODO", filePath: "a.ts"))
  #expect(call.toolCallId == "tc_1")
}

@Test func progressDecodesThroughTheDiscriminatedUnion() throws {
  let part = ToolCallPart(
    json: json(
      #"{"type":"tool-call","toolCallId":"tc_2","name":"bash","input":{"command":"ls"},"progress":[{"stage":"started","pid":42},{"stage":"line","text":"a.ts","stream":"stdout"},{"stage":"exploded"}]}"#
    ))
  guard case .bash(let call) = SupportAgent.toolCall(part) else {
    Issue.record("expected .bash")
    return
  }
  // The third entry is a stage this file does not know: left out of the typed
  // list, kept in the raw one.
  #expect(
    call.progress == [
      .started(.init(stage: "started", pid: 42)),
      .line(.init(stage: "line", text: "a.ts", stream: .stdout)),
    ])
  #expect(call.part.progress.count == 3)
}

@Test func aPartialCallHasNoInputYet() throws {
  let part = ToolCallPart(
    json: json(
      #"{"type":"tool-call","toolCallId":"tc_3","name":"grep","input":{"pattern":"TO"},"partial":true}"#
    ))
  guard case .grep(let call) = SupportAgent.toolCall(part) else {
    Issue.record("expected .grep")
    return
  }
  #expect(call.input == nil)
  #expect(call.part.partial)
}

@Test func aResultDecodesItsOutcome() throws {
  let paid = ToolResultPart(
    json: json(
      #"{"type":"tool-result","toolCallId":"tc_4","name":"charge","status":"ok","output":{"status":"paid","receiptId":"rc_1"}}"#
    ))
  guard case .charge(let result) = SupportAgent.toolResult(paid) else {
    Issue.record("expected .charge")
    return
  }
  #expect(result.outcome == .ok(.paid(.init(status: "paid", receiptId: "rc_1"))))

  let denied = ToolResultPart(
    json: json(
      #"{"type":"tool-result","toolCallId":"tc_5","name":"charge","status":"denied","cause":"refused","reason":"too much"}"#
    ))
  guard case .charge(let refusal) = SupportAgent.toolResult(denied) else {
    Issue.record("expected .charge")
    return
  }
  #expect(refusal.outcome == .denied(cause: "refused", reason: "too much"))
}

@Test func anythingTheFileDoesNotKnowIsUnknownRatherThanAFailure() throws {
  // A tool added on the server since this file was generated.
  let newTool = ToolCallPart(
    json: json(#"{"type":"tool-call","toolCallId":"tc_6","name":"brandNew","input":{}}"#))
  #expect(SupportAgent.toolCall(newTool) == .unknown(newTool))

  // A known tool whose output no longer matches its type.
  let drifted = ToolResultPart(
    json: json(
      #"{"type":"tool-result","toolCallId":"tc_7","name":"grep","status":"ok","output":{"matches":"not a list"}}"#
    ))
  #expect(SupportAgent.toolResult(drifted) == .unknown(drifted))
}

@Test func aSnakeCaseToolIsACamelCaseCase() throws {
  let part = ToolCallPart(
    json: json(
      #"{"type":"tool-call","toolCallId":"tc_8","name":"refund_order","input":{"orderId":"o_1"}}"#
    ))
  guard case .refundOrder(let call) = SupportAgent.toolCall(part) else {
    Issue.record("expected .refundOrder")
    return
  }
  #expect(call.input?.orderId == "o_1")
}

@Test func aPendingQuestionKnowsTheTypeOfItsAnswer() throws {
  let pending = PendingToolCall(
    json: json(
      #"{"toolCallId":"tc_9","name":"ask","input":{"question":"Which order?"},"kind":"question","signature":"sig"}"#
    ))
  guard case .ask(let call) = SupportAgent.pending(pending) else {
    Issue.record("expected .ask")
    return
  }
  #expect(call.input?.question == "Which order?")
  // `TypedPendingCall<AskInput, AskOutput>`: the answer's type is fixed here.
  let _: SupportAgent.AskOutput.Type = type(of: call).Answer.self
}

@Test func aRequiredNullableKeyIsWrittenAsNullAndAnOptionalOneIsLeftOut() throws {
  let input = SupportAgent.ChargeInput(amountCents: 500, currency: .try, reason: nil)
  let encoded = try JSONValue(encoding: input)
  // `reason` is `.nullable()` on the server, so it must be present; `metadata`
  // is `.optional()`, so it must not.
  #expect(encoded["reason"] == .null)
  #expect(encoded["metadata"] == nil)
  #expect(encoded["currency"] == "try")
}

@Test func aKeywordKeyRoundTrips() throws {
  let output = SupportAgent.RefundOrderOutput(refundId: "rf_1", default: true)
  let encoded = try JSONValue(encoding: output)
  #expect(encoded == ["refundId": "rf_1", "default": true])
  #expect(try encoded.decode(as: SupportAgent.RefundOrderOutput.self) == output)
}

@Test func aStructuredOutputDecodesOnceItIsWhole() throws {
  let partial = OutputPart(
    json: json(#"{"type":"output","value":{"sentiment":"positive"},"partial":true}"#))
  #expect(Classifier.output(partial) == nil)

  let whole = OutputPart(
    json: json(#"{"type":"output","value":{"sentiment":"negative","topics":["billing"]}}"#))
  #expect(Classifier.output(whole) == .init(sentiment: .negative, topics: ["billing"]))
}

@Test func aKeywordToolNarrowsAndItsKeywordKeysEncode() throws {
  let part = ToolCallPart(
    json: json(
      #"{"type":"tool-call","toolCallId":"tc_10","name":"default","input":{"in":null,"for":"x"}}"#
    ))
  guard case .default(let call) = SupportAgent.toolCall(part) else {
    Issue.record("expected .default")
    return
  }
  #expect(call.input == SupportAgent.DefaultInput(in: nil, for: "x"))
  // `in` is a required nullable, so the file writes its own `encode`.
  #expect(try JSONValue(encoding: call.input!) == ["in": .null, "for": "x"])
}

@Test func aRecursiveTaggedUnionIsTypedOneLevelThenRawJSON() throws {
  let node: JSONValue = [
    "kind": "branch",
    "children": [["kind": "leaf", "value": "a"], ["kind": "branch", "children": []]],
  ]
  let decoded = try node.decode(as: OddAgent.OddOutputNode.self)
  guard case .branch(let branch) = decoded else {
    Issue.record("expected .branch")
    return
  }
  #expect(branch.children.first == .leaf(.init(kind: "leaf", value: "a")))
  #expect(branch.children.last == .branch(["kind": "branch", "children": []]))
  #expect(try JSONValue(encoding: decoded) == node)
}
