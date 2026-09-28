import { AgentTool, type AnyAgentTool } from "../../ai/Agent";
import { RequestContext } from "../../http/requestContext";
import type { McpRegistry, McpToolFilter } from "./McpRegistry";

/**
 * The registry's tools as `AgentTool`s, for an agent running in this server —
 * v1's only projection.
 *
 * Build them once and hand them to `Agent.create`. None of them holds a user:
 * the caller is `{ kind: "local", req }`, where `req` is the request the run is
 * executing inside, taken when the tool executes, so the same tools run as
 * whichever user's run calls them. That is the reason the caller is not an
 * argument here.
 *
 * AMBIENT, AND ONLY HERE. A run is not given a request (see `AgentContext`),
 * but these tools have no other way to act as a user: the route is dispatched
 * with the initiator's own credentials, and those live on the request. A run
 * started by `AgentController` executes inside its request, which the run holds
 * open until it settles, so the request is there to read. A run started from a
 * job or a script has none, and these tools refuse there with a sentence
 * saying so rather than dispatching as nobody.
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
      execute: (input, ctx) => {
        const req = RequestContext.getStore()?.req;
        if (!req) {
          throw new Error(
            `"${descriptor.name}" calls an api route as the user who started this run, and this run was not started inside a request. Run it from an AgentController, or give this agent tools that do not go through the MCP registry.`,
          );
        }
        return registry.execute({ kind: "local", req }, descriptor.name, input, ctx);
      },
    }),
  );
}
