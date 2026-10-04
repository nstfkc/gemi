/**
 * Type-level tests for `toAgentTools`' overloads: the flat call still answers
 * `AgentTool`s, the grouped one answers entries an agent takes as `tools`.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import { Agent, type AnyAgentTool, type ToolEntry } from "../../ai/Agent";
import type { AgentProvider } from "../../ai/AgentProvider";
import type { McpRegistry } from "./McpRegistry";
import { toAgentTools } from "./toAgentTools";

declare const registry: McpRegistry;
declare const provider: AgentProvider;

describe("toAgentTools", () => {
  test("a filter, or options without namespaces, answers AgentTools", () => {
    expectTypeOf(toAgentTools(registry)).toEqualTypeOf<AnyAgentTool[]>();
    expectTypeOf(toAgentTools(registry, { tags: ["orders"] })).toEqualTypeOf<AnyAgentTool[]>();
    expectTypeOf(toAgentTools(registry, { deferred: true })).toEqualTypeOf<AnyAgentTool[]>();
  });

  test("namespaces answer ToolEntries, which an agent takes", () => {
    const tools = toAgentTools(registry, {
      namespaces: { orders: { description: "Orders", deferred: true } },
      deferred: true,
    });
    expectTypeOf(tools).toEqualTypeOf<ToolEntry[]>();
    Agent.create({ name: "shop", provider, tools });
  });

  test("a namespace needs a description", () => {
    // @ts-expect-error description is required
    toAgentTools(registry, { namespaces: { orders: { deferred: true } } });
  });
});
