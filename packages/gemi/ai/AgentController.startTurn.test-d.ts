import { describe, expectTypeOf, test } from "vitest";

import { Agent } from "./Agent";
import { AgentController, type AgentTurn, type AgentTurnResult } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";

/**
 * `startTurn` (#839) takes the controller's own `Body`, as `useChat` does, and
 * is only callable on a concrete controller.
 */

const agent = Agent.create({ name: "page", provider: OpenAIProvider.model("gpt-5.4") });

interface PageBody {
  pageId: string;
}

class PageChat extends AgentController<typeof agent, PageBody> {
  agent = agent;
}

class OpenChat extends AgentController<typeof agent> {
  agent = agent;
}

describe("AgentController.startTurn", () => {
  test("takes the controller's Body", () => {
    expectTypeOf(
      PageChat.startTurn({ threadId: "t", text: "hi", body: { pageId: "p" } }),
    ).toEqualTypeOf<Promise<AgentTurn>>();

    // @ts-expect-error a field the controller does not declare
    void PageChat.startTurn({ threadId: "t", body: { pageId: "p", other: 1 } });
    // @ts-expect-error the wrong type for a declared field
    void PageChat.startTurn({ threadId: "t", body: { pageId: 1 } });
    // @ts-expect-error a threadId is required
    void PageChat.startTurn({ text: "hi" });

    void OpenChat.startTurn({ threadId: "t", body: { anything: true } });
  });

  test("is not callable on the abstract base", () => {
    // @ts-expect-error AgentController is abstract
    void AgentController.startTurn({ threadId: "t" });
  });

  test("the result carries the text and the pending calls", () => {
    expectTypeOf<AgentTurnResult["text"]>().toEqualTypeOf<string>();
    expectTypeOf<AgentTurnResult["threadId"]>().toEqualTypeOf<string>();
    expectTypeOf<AgentTurnResult["finishReason"]>().not.toBeAny();
  });
});
