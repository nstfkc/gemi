process.env.SECRET ??= "agent-controller-state-test-secret";

import { expect, test } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { stateKey } from "../http/requestState";
import { Agent } from "./Agent";
import {
  AgentController,
  type AgentHookContext,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
import { fakeProvider } from "./providers/fakeProvider";
import type { AgentMessage, AgentRunResult } from "./types";

/**
 * #887: what a turn's `context()` decided is read back in its hooks from
 * `ctx.req.state`, rather than from a `WeakMap` keyed on the request.
 */

const turn = stateKey<{ sentFrom: string; seen: string[] }>("turn");

function jsonRequest(body: unknown) {
  const raw = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new HttpRequest(raw, {}, "api", "/chat");
}

test("a value set in context() is the turn's, in onMessage and onStreamComplete", async () => {
  const provider = fakeProvider([
    { type: "text-delta", delta: "hello" },
    {
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]);
  const store = new MemoryAgentStore();
  let completed: { sentFrom: string; seen: string[] } | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  class Chat extends AgentController {
    agent = Agent.create({ name: "chat", provider }) as any;
    store = store;
    liveRuns = new MemoryLiveRuns();

    context(req: HttpRequest<any, any>, { body }: { body: Record<string, unknown> }) {
      req.state.set(turn, { sentFrom: String(body.sentFrom), seen: [] });
      return {};
    }

    protected onMessage(message: AgentMessage, ctx: AgentHookContext) {
      ctx.req.state.require(turn).seen.push(message.role);
    }

    protected onStreamComplete(_result: AgentRunResult<any, any>, ctx: AgentHookContext) {
      completed = ctx.req.state.get(turn);
      done();
    }
  }

  const { threadId } = await store.createThread({});
  const first = await new Chat().stream(
    jsonRequest({ threadId, turn: { text: "hi" }, sentFrom: "page:1" }),
  );
  await first.text();
  await finished;

  expect(completed).toEqual({ sentFrom: "page:1", seen: ["user", "assistant"] });
});
