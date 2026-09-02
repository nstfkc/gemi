import { describe, expect, test } from "vitest";

import { capabilitiesForModel, parseFamily } from "./capabilities";

describe("capabilitiesForModel()", () => {
  test("a current model has everything", () => {
    expect(capabilitiesForModel("gpt-5.4")).toEqual({
      reasoning: true,
      structuredOutput: true,
      fileInput: true,
      parallelToolCalls: true,
      toolSearch: true,
    });
  });

  test("gpt-4o reasons about nothing and cannot search for tools", () => {
    expect(capabilitiesForModel("gpt-4o-mini-2024-07-18")).toMatchObject({
      reasoning: false,
      structuredOutput: true,
      fileInput: true,
      toolSearch: false,
    });
  });

  test("o1 reasons but takes its tool calls one at a time", () => {
    expect(capabilitiesForModel("o1")).toMatchObject({
      reasoning: true,
      parallelToolCalls: false,
      toolSearch: false,
    });
    expect(capabilitiesForModel("o3-mini")).toMatchObject({ parallelToolCalls: true });
  });

  test("gpt-3.5 gets none of it", () => {
    expect(capabilitiesForModel("gpt-3.5-turbo")).toEqual({
      reasoning: false,
      structuredOutput: false,
      fileInput: false,
      parallelToolCalls: true,
      toolSearch: false,
    });
  });

  /**
   * The load-bearing case. An id nobody shipped knowing about is assumed
   * capable, so a model released after this release is usable by naming it —
   * and the way that assumption fails is one loud 400, not a silently worse
   * agent.
   */
  test("an unknown id gets every capability", () => {
    for (const id of ["gpt-7", "o9-mini", "some-gateway/llama-4", "prod-deployment"]) {
      expect(capabilitiesForModel(id), id).toEqual({
        reasoning: true,
        structuredOutput: true,
        fileInput: true,
        parallelToolCalls: true,
        toolSearch: true,
      });
    }
  });

  test("case and whitespace do not change the answer", () => {
    expect(capabilitiesForModel("  GPT-4O  ")).toEqual(capabilitiesForModel("gpt-4o"));
  });

  test("a model that only starts with o is not an o-series generation", () => {
    for (const id of ["omni-moderation-latest", "o200k-base"]) {
      expect(capabilitiesForModel(id), id).toEqual(capabilitiesForModel("unknown-model"));
    }
  });
});

/**
 * Tested through the classifier rather than through `capabilitiesForModel`,
 * because that is the only place the boundary is visible: `o200k-base` read as
 * generation 200 happens to produce the same all-true answer as an unknown id
 * today, so an assertion on capabilities would pass with the guard removed and
 * fail the day a rule keys on `major`.
 */
describe("parseFamily()", () => {
  test("reads the generation out of a model id", () => {
    expect(parseFamily("gpt-5.4-mini-2025-01-01")).toEqual({ kind: "gpt", major: 5 });
    expect(parseFamily("o3-mini")).toEqual({ kind: "o", major: 3 });
    expect(parseFamily("o1")).toEqual({ kind: "o", major: 1 });
  });

  test("leading digits that are not a generation are not one", () => {
    // A tokenizer, not a model — and `/^o(\d+)/` without the boundary calls it
    // generation 200.
    expect(parseFamily("o200k-base")).toBeNull();
    // `m` is not a digit, so this one never reaches the boundary at all.
    expect(parseFamily("omni-moderation-latest")).toBeNull();
    expect(parseFamily("some-gateway/llama-4")).toBeNull();
  });
});
