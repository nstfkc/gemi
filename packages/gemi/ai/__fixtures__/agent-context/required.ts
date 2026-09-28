/**
 * An app whose `AgentContext` has a REQUIRED field. Compiled by
 * `ai/agentContext.test.ts`; see that file for why this is not a `*.test-d.ts`.
 *
 * Exactly one error is expected, on the marked line.
 */
import { Agent, OpenAIProvider } from "gemi/ai";

declare module "gemi/ai" {
  interface AgentContext {
    userId: string;
  }
}

const agent = Agent.create({
  name: "fixture",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [],
});

// Must NOT compile: the app declared a field it never passed. This is the whole
// promise — an app that adds a field to `AgentContext` is shown every run that
// now has to supply it, instead of finding out from a tool reading `undefined`.
agent.stream({ messages: [] });

// Must compile.
agent.stream({ messages: [], context: { userId: "u_1" } });
