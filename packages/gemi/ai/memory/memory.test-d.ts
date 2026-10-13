/**
 * Type-level tests for agent memory (#936): the built-in tools' parts are
 * typed on the client when an agent declares `memory`, so a UI can render
 * "Saved to memory · Undo" off `part.output`, and nothing changes for an
 * agent without it.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import { Agent, AgentTool, type AgentToolShapes, type ToolShapesOf } from "../Agent";
import { AgentController, type AgentRouteRPC } from "../AgentController";
import { OpenAIProvider } from "../AgentProvider";
import { s } from "../Schema";
import type { ToolResultPart } from "../types";
import type { MemoryToolShapes, RememberResult, ToolMemory } from "./runMemory";

const provider = OpenAIProvider.model("gpt-5.4");

const lookup = AgentTool.create({
  name: "lookup",
  description: "Look something up",
  inputSchema: s.object({ q: s.string() }),
  execute: async (input, ctx) => {
    expectTypeOf(ctx.memory).toEqualTypeOf<ToolMemory>();
    return { found: input.q };
  },
});

const remembering = Agent.create({
  name: "site",
  provider,
  tools: [lookup],
  memory: { scopes: { project: { description: "The business." } } },
});

const plain = Agent.create({ name: "plain", provider, tools: [lookup] });

const silent = Agent.create({
  name: "silent",
  provider,
  tools: [lookup],
  memory: { scopes: { project: { description: "The business." } }, tools: false },
});

class SiteChat extends AgentController<typeof remembering> {
  agent = remembering;
  protected memoryScopes() {
    return { project: "project:1" };
  }
}

describe("memory tool shapes", () => {
  test("an agent with memory has remember, forget and recall parts", () => {
    type Shapes = AgentToolShapes<typeof remembering>;
    expectTypeOf<Shapes["remember"]["output"]>().toEqualTypeOf<RememberResult>();
    expectTypeOf<keyof Shapes>().toEqualTypeOf<"lookup" | keyof MemoryToolShapes>();

    type Part = ToolResultPart<Shapes>;
    const part = {} as Part;
    if (part.name === "remember" && part.status === "ok") {
      expectTypeOf(part.output.action).toEqualTypeOf<"added" | "updated" | "unchanged">();
      expectTypeOf(part.output.id).toEqualTypeOf<string>();
    }
  });

  test("the route carries them to the client", () => {
    expectTypeOf<AgentRouteRPC<typeof SiteChat>["tools"]>().toEqualTypeOf<
      AgentToolShapes<typeof remembering>
    >();
  });

  test("an agent without memory, or with its tools off, is unchanged", () => {
    expectTypeOf<AgentToolShapes<typeof plain>>().toEqualTypeOf<
      ToolShapesOf<(typeof plain)["tools"]>
    >();
    expectTypeOf<AgentToolShapes<typeof silent>>().toEqualTypeOf<
      ToolShapesOf<(typeof silent)["tools"]>
    >();
  });

  test("Agent.stream takes the run's memory scopes", () => {
    remembering.stream({ messages: [], memory: { scopes: { project: "project:1", user: null } } });
    remembering.stream({ messages: [], memory: { scopes: {}, maxTokens: 500 } });
  });
});
