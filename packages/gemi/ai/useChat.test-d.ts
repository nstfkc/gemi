import { describe, expectTypeOf, test } from "vitest";

import { Agent, AgentTool } from "./Agent";
import { AgentController, type AgentRouteRPC } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import type { UseChatParams } from "./useChat";

/**
 * **`onToolResult`, typed by the agent's own tools.**
 *
 * The callback is only worth having if `part.name === "editComponent"` narrows
 * `part.output` — an app that has to cast is back to reading `unknown` and
 * checking a string by hand. That narrowing comes from the route's `RPC` entry,
 * which an application augments, so this file augments it with one route rather
 * than adding an agent to the template.
 */

const editComponent = AgentTool.create({
  name: "editComponent",
  description: "Edit one component",
  inputSchema: s.object({ id: s.string() }),
  outputSchema: s.object({ ok: s.boolean(), revision: s.number() }),
  execute: async () => ({ ok: true, revision: 1 }),
});

const renamePage = AgentTool.create({
  name: "renamePage",
  description: "Rename the page",
  inputSchema: s.object({ title: s.string() }),
  outputSchema: s.object({ title: s.string() }),
  execute: async () => ({ title: "x" }),
});

const pageAgent = Agent.create({
  name: "page-builder",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [editComponent, renamePage],
});

class PageBuilderController extends AgentController<typeof pageAgent> {
  agent = pageAgent;
}

declare module "../client/rpc" {
  interface RPC {
    "/page-builder": AgentRouteRPC<typeof PageBuilderController>;
  }
}

type OnToolResult = NonNullable<UseChatParams<"/page-builder">["onToolResult"]>;
type Part = Parameters<OnToolResult>[0];

describe("onToolResult", () => {
  test("takes the agent's tool results, discriminated by name", () => {
    expectTypeOf<Part["name"]>().toEqualTypeOf<"editComponent" | "renamePage">();
  });

  test("narrows the output on the tool name", () => {
    const handler: OnToolResult = (part) => {
      // `status` first: a result can be an error or a refusal, and neither has
      // an `output` to read. That this does not compile the other way round is
      // the property worth having.
      if (part.status !== "ok") return;
      if (part.name === "editComponent") {
        expectTypeOf(part.output).toEqualTypeOf<{ ok: boolean; revision: number }>();
      } else {
        expectTypeOf(part.output).toEqualTypeOf<{ title: string }>();
      }
    };
    void handler;
  });

  test("does not offer output before status has been checked", () => {
    const handler: OnToolResult = (part) => {
      if (part.name !== "editComponent") return;
      // @ts-expect-error a denied or errored result has no `output`.
      void part.output;
    };
    void handler;
  });

  test("refuses a tool the agent does not have", () => {
    const handler: OnToolResult = (part) => {
      // @ts-expect-error `deletePage` is not one of this agent's tools.
      if (part.name === "deletePage") return;
    };
    void handler;
  });

  test("carries the error shape on a failed result", () => {
    const handler: OnToolResult = (part) => {
      if (part.status === "error") {
        expectTypeOf(part.error.message).toEqualTypeOf<string>();
      }
      if (part.status === "denied") {
        expectTypeOf(part.cause).toEqualTypeOf<"refused" | "stopped">();
      }
    };
    void handler;
  });
});
