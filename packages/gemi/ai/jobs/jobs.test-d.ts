/**
 * Type-level tests for background jobs (#461). Run with `bun run test:types`.
 *
 * The claim: a tool that returns `ctx.jobs.start(Job, …)` has the job's output
 * as its own, so a client's tool shapes see the settled result, not the handle.
 */
import { describe, expectTypeOf, test } from "vitest";

import { AgentTool, type ToolShapesOf } from "../Agent";
import { s } from "../Schema";
import type { ToolResultPart } from "../types";
import { AgentJob, type AgentJobContext, type JobHandle } from "./AgentJob";

class Render extends AgentJob<{ prompts: string[] }, { made: number }> {
  static name = "Render";
  async run(args: { prompts: string[] }, job: AgentJobContext) {
    void job;
    return { made: args.prompts.length };
  }
}

const render = AgentTool.create({
  name: "render",
  description: "x",
  inputSchema: s.object({ prompts: s.array(s.string()) }),
  async: { deadlineMs: 60_000 },
  async execute({ prompts }, ctx) {
    return ctx.jobs.start(Render, { prompts });
  },
});

const tracked = AgentTool.create({
  name: "tracked",
  description: "x",
  inputSchema: s.object({}),
  async: {},
  async execute(_input, ctx) {
    return ctx.jobs.track<{ url: string }>();
  },
});

const plain = AgentTool.create({
  name: "plain",
  description: "x",
  inputSchema: s.object({}),
  async execute() {
    return { ok: true };
  },
});

type Shapes = ToolShapesOf<[typeof render, typeof tracked, typeof plain]>;

describe("an async tool's output is its job's", () => {
  test("start", () => {
    expectTypeOf<Shapes["render"]["output"]>().toEqualTypeOf<{ made: number }>();
  });

  test("track", () => {
    expectTypeOf<Shapes["tracked"]["output"]>().toEqualTypeOf<{ url: string }>();
  });

  test("a tool that never returns a handle is unchanged", () => {
    expectTypeOf<Shapes["plain"]["output"]>().toEqualTypeOf<{ ok: boolean }>();
  });

  test("start checks the job's arguments", () => {
    AgentTool.create({
      name: "bad",
      description: "x",
      inputSchema: s.object({}),
      async: {},
      async execute(_input, ctx): Promise<JobHandle<{ made: number }>> {
        // @ts-expect-error `prompts` is a string array
        return ctx.jobs.start(Render, { prompts: 1 });
      },
    });
  });

  test("a running result carries the job", () => {
    type Running = Extract<ToolResultPart<Shapes>, { status: "running" }>;
    expectTypeOf<Running["job"]["id"]>().toEqualTypeOf<string>();
  });
});
