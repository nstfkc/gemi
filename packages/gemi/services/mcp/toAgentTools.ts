import { AgentTool, type AnyAgentTool } from "../../ai/Agent";
import type { McpRegistry, McpToolFilter } from "./McpRegistry";

/**
 * The registry's tools as `AgentTool`s, for an agent running in this server —
 * v1's only projection.
 *
 * Build them once and hand them to `Agent.create`. None of them holds a user:
 * the caller is `{ kind: "local", req: ctx.req }`, taken when the tool
 * executes, so the same tools run as whichever user's run calls them. That is
 * the reason the caller is not an argument here.
 *
 * `requiresApproval` comes from the route's meta, where the app wrote it down;
 * it is never inferred from the verb.
 *
 * A failure the model should read — a 4xx, a missing file, a bad argument —
 * throws, and the agent loop turns a throw into a `tool_error` result the model
 * sees and can correct on its next step.
 */
export function toAgentTools(registry: McpRegistry, filter?: McpToolFilter): AnyAgentTool[] {
  return registry.descriptors(filter).map((descriptor) =>
    AgentTool.create({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      requiresApproval: descriptor.requiresApproval,
      execute: (input, ctx) =>
        registry.execute({ kind: "local", req: ctx.req }, descriptor.name, input, ctx),
    }),
  );
}
