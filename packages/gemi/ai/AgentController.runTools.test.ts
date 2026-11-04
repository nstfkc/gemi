process.env.SECRET ??= "agent-controller-run-tools-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import { AgentTool, type AgentStreamParams } from "./Agent";
import {
  AgentController,
  type AgentRunTools,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import { s } from "./Schema";
import { StubAgentRun } from "./store/stubAgentRun";

/**
 * #1123: `runTools()` decides a turn's own tools and which tools are offered,
 * from the request and the run's context, and hands them to `Agent.stream`.
 */

const extra = AgentTool.create({
  name: "lookup",
  description: "Look something up",
  inputSchema: s.object({}),
  execute: async () => "found",
});

function setup(answer?: (req: HttpRequest<any, any>, extra: { body: any; context: any }) => AgentRunTools | void) {
  const calls: AgentStreamParams[] = [];
  const seen: { body: unknown; context: unknown }[] = [];
  const agent = {
    name: "stub",
    tools: [] as const,
    skills: [] as const,
    output: undefined,
    stream: (params: AgentStreamParams) => {
      calls.push(params);
      const run = new StubAgentRun(params.runId ?? "run_1");
      queueMicrotask(() => run.finish());
      return run;
    },
  } as any;
  class Chat extends AgentController {
    agent = agent;
    liveRuns = new MemoryLiveRuns();
    store = new MemoryAgentStore({ clientOwnedIds: true });
    context() {
      return { tenant: "t_1" } as any;
    }
    protected runTools(req: HttpRequest<any, any>, x: { body: any; context: any }) {
      seen.push(x);
      return answer?.(req, x);
    }
  }
  const req = new HttpRequest(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turn: { text: "hi" }, pageId: "p_1" }),
    }),
    {},
    "api",
    "/chat",
  );
  const send = () =>
    RequestContext.run(req as any, async () => {
      RequestContext.getStore().setUser({ id: 1 });
      const response = await new Chat().stream(req);
      await response.text();
    });
  return { calls, seen, send };
}

describe("AgentController.runTools (#1123)", () => {
  test("is handed the body and the run's context, and its answer reaches the run", async () => {
    const { calls, seen, send } = setup(() => ({ tools: [extra], activeTools: ["lookup"] }));
    await send();
    expect(seen).toEqual([{ body: { pageId: "p_1" }, context: { tenant: "t_1" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools).toEqual([extra]);
    expect(calls[0]!.activeTools).toEqual(["lookup"]);
  });

  test("answering nothing passes neither, so the agent's tools are all offered", async () => {
    const { calls, send } = setup();
    await send();
    expect(calls).toHaveLength(1);
    expect("tools" in calls[0]!).toBe(false);
    expect("activeTools" in calls[0]!).toBe(false);
  });
});
