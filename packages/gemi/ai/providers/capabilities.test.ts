import { describe, expect, test } from "vitest";

import { capabilitiesForModel, parseFamily } from "./capabilities";
import { toResponsesTools } from "./request";

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

  /**
   * The other half of "an unknown id gets every capability": what happens next.
   * The guess is fed to `toResponsesTools`, which sends a `tool_search` tool and
   * deferred schemas, and a model that has neither answers a 400 naming the
   * parameter — `param: "tools"` — which `normalizeProviderError` turns into
   * `invalid_tool_input`. One loud failure with a one-line fix
   * (`OpenAIProvider.model(id, {})` and a capability override, or a different
   * id), which is the trade the module comment argues for. The recorded 400
   * itself is asserted in `recordings.test.ts`; this is the half that shows the
   * guess is actually acted on.
   */
  test("an unknown id is not just optimistic, it is optimistic in the request", () => {
    const caps = capabilitiesForModel("prod-deployment");
    const tools = toResponsesTools(
      [
        {
          name: "crm",
          description: "CRM",
          tools: [
            {
              name: "getOrder",
              description: "Get an order.",
              parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
              strict: true,
              deferred: true,
            },
          ],
        },
      ],
      caps,
    );

    expect(tools.some((t) => t.type === "tool_search")).toBe(true);
    expect(tools.some((t) => t.type === "namespace")).toBe(true);
  });

  /**
   * And the quiet direction, which is the one that has to be right: a model
   * measured as unable to search gets the namespace flattened and every schema
   * inline, so the same tools are reachable and only the token bill changes.
   * Confirmed against the live API — gpt-5.1 called `getOrder` from a flattened
   * `crm` namespace with no 400 and no tool-search step.
   */
  test("a known-old id degrades quietly instead, with the same tools reachable", () => {
    const caps = capabilitiesForModel("gpt-5.1");
    expect(caps.toolSearch).toBe(false);

    const tools = toResponsesTools(
      [
        {
          name: "crm",
          description: "CRM",
          tools: [
            {
              name: "getOrder",
              description: "Get an order.",
              parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
              strict: true,
              deferred: true,
            },
          ],
        },
      ],
      caps,
    );

    expect(tools).toEqual([
      expect.objectContaining({ type: "function", name: "getOrder", strict: true }),
    ]);
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
    expect(parseFamily("gpt-5.4-mini-2025-01-01")).toEqual({ kind: "gpt", major: 5, minor: 4 });
    expect(parseFamily("gpt-5")).toEqual({ kind: "gpt", major: 5, minor: 0 });
    // Not a minor: `4o` is the model's name, not `gpt-4` point release zero
    // followed by something. It reads as minor 0, which is the same answer.
    expect(parseFamily("gpt-4o")).toEqual({ kind: "gpt", major: 4, minor: 0 });
    expect(parseFamily("o3-mini")).toEqual({ kind: "o", major: 3, minor: 0 });
    expect(parseFamily("o1")).toEqual({ kind: "o", major: 1, minor: 0 });
  });

  /**
   * The minor is why this classifier exists at all now. Measured against the
   * live API: gpt-5.2 and up accept a `tool_search` tool, gpt-5.1 and below
   * answer `Tool 'tool_search' is not supported with gpt-5.1.` — so a
   * major-only reading puts a `defer_loading` request in front of three shipped
   * models that 400 on it.
   */
  test("the minor is what decides tool search inside the gpt-5 generation", () => {
    for (const id of ["gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-5.1-codex"]) {
      expect(capabilitiesForModel(id), id).toMatchObject({ toolSearch: false, reasoning: true });
    }
    for (const id of ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.10"]) {
      expect(capabilitiesForModel(id), id).toMatchObject({ toolSearch: true });
    }
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
