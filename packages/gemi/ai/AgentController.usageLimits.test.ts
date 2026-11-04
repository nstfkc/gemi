process.env.SECRET ??= "agent-controller-usage-limits-test-secret";

import { describe, expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type { AgentStreamParams } from "./Agent";
import {
  AgentController,
  type AgentRunTools,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import { StubAgentRun } from "./store/stubAgentRun";
import type { AgentUsageLimits } from "./usageLimits";

/** #1124: `usageLimits()` decides a turn's budgets and hands them to `Agent.stream`. */

function setup(
  answer?: (extra: { body: any; context: any }) => AgentUsageLimits | void,
  runTools?: (extra: { body: any; context: any }) => AgentRunTools | void,
) {
  const calls: AgentStreamParams[] = [];
  const seen: { body: unknown; context: unknown }[] = [];
  const order: string[] = [];
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
    protected usageLimits(_req: HttpRequest<any, any>, extra: { body: any; context: any }) {
      order.push("usageLimits");
      seen.push(extra);
      return answer?.(extra);
    }
    protected runTools(_req: HttpRequest<any, any>, extra: { body: any; context: any }) {
      order.push("runTools");
      return runTools?.(extra);
    }
  }
  const request = () =>
    new HttpRequest(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn: { text: "hi" }, pageId: "p_1" }),
      }),
      {},
      "api",
      "/chat",
    );
  const send = () => {
    const req = request();
    return RequestContext.run(req as any, async () => {
      RequestContext.getStore().setUser({ id: 1 });
      const response = await new Chat().stream(req);
      await response.text();
    });
  };
  return { calls, seen, order, send };
}

describe("AgentController.usageLimits (#1124)", () => {
  test("is handed the body and the run's context, and its answer reaches the run", async () => {
    const limits: AgentUsageLimits = {
      run: { tokens: 1000 },
      scopes: [{ key: "tenant:t_1", limit: { steps: 100 } }],
    };
    const { calls, seen, send } = setup(({ context }) =>
      context.tenant === "t_1" ? limits : undefined,
    );
    await send();
    expect(seen).toEqual([{ body: { pageId: "p_1" }, context: { tenant: "t_1" } }]);
    expect(calls[0]!.usageLimits).toBe(limits);
  });

  test("answering nothing sets no limits", async () => {
    const { calls, send } = setup();
    await send();
    expect("usageLimits" in calls[0]!).toBe(false);
  });

  test("runs beside runTools, both once per turn, and the run gets both answers", async () => {
    const limits: AgentUsageLimits = { run: { toolCalls: 5 } };
    const tools: AgentRunTools = { tools: [], activeTools: ["search"] };
    const { calls, order, send } = setup(() => limits, () => tools);
    await send();
    await send();
    expect(order).toEqual(["runTools", "usageLimits", "runTools", "usageLimits"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.usageLimits).toBe(limits);
    expect(calls[1]!.activeTools).toEqual(["search"]);
  });
});
