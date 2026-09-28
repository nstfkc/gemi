/**
 * An app whose `AgentContext` has only OPTIONAL fields. Compiled by
 * `ai/agentContext.test.ts`.
 *
 * No error is expected: an app that declares nothing required must not be made
 * to pass `{}` at every call site.
 */
import { Agent, OpenAIProvider } from "gemi/ai";

declare module "gemi/ai" {
  interface AgentContext {
    userId?: string;
  }
}

const agent = Agent.create({
  name: "fixture",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [],
});

agent.stream({ messages: [] });
agent.stream({ messages: [], context: { userId: "u_1" } });
