import { describe, expect, test } from "vitest";

import { capabilitiesForModel } from "./capabilities";

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

  test("omni-moderation does not read as generation zero", () => {
    expect(capabilitiesForModel("omni-moderation-latest").toolSearch).toBe(true);
  });
});
