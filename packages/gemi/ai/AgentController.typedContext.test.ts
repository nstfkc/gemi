process.env.SECRET ??= "agent-controller-typed-context-test-secret";

import { describe, expect, test } from "vitest";

import type { HttpRequest } from "../http/HttpRequest";
import { Agent } from "./Agent";
import { AgentController, MemoryAgentStore, MemoryLiveRuns } from "./AgentController";
import type { ProviderEvent } from "./AgentProvider";
import { fakeProvider } from "./providers/fakeProvider";
import { s } from "./Schema";

/**
 * #1019: an agent declares its context, data and functions, and its
 * controller builds it in `context()` from the services it was constructed
 * with. The tools only call what the context hands them.
 */

const finish = (): ProviderEvent => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

type PageBody = { pageId: string };
type PageContext = {
  pageId: string;
  edit(instruction: string): Promise<string>;
};

/** Stands in for an app's `Service`: what the controller injects. */
class PageEditor {
  readonly edits: string[] = [];
  async edit(pageId: string, instruction: string) {
    this.edits.push(`${pageId}: ${instruction}`);
    return `edited ${pageId}`;
  }
}

function setup() {
  const editor = new PageEditor();
  const store = new MemoryAgentStore();
  const page = Agent.withContext<PageContext>();
  const editTool = page.tool({
    name: "edit",
    description: "Edit the page",
    inputSchema: s.object({ instruction: s.string() }),
    execute: ({ instruction }, ctx) => ctx.context.edit(instruction),
  });
  const provider = fakeProvider(
    [
      {
        type: "tool-call",
        toolCallId: "c1",
        name: "edit",
        args: '{"instruction":"darker hero"}',
      },
      finish(),
    ],
    [{ type: "text-delta", delta: "Done." }, finish()],
  );
  const pageAgent = page.agent({ name: "page", provider, tools: [editTool] });

  class PageChat extends AgentController<typeof pageAgent, PageBody> {
    agent = pageAgent;
    store = store;
    liveRuns = new MemoryLiveRuns();

    constructor(private pages = editor) {
      super();
    }

    context(_req: HttpRequest<any, any>, { body }: { body: PageBody }): PageContext {
      return {
        pageId: body.pageId,
        edit: (instruction) => this.pages.edit(body.pageId, instruction),
      };
    }
  }

  return { editor, store, PageChat };
}

describe("an agent's typed context, built by its controller", () => {
  test("reaches the tools of a server turn, functions and all", async () => {
    const { editor, store, PageChat } = setup();
    const { threadId } = await store.createThread({ userId: 1 });

    const result = await (
      await PageChat.startTurn({
        threadId,
        text: "Darker hero",
        user: { id: 1 },
        body: { pageId: "p_1" },
      })
    ).result();

    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Done.");
    expect(editor.edits).toEqual(["p_1: darker hero"]);
    const toolResult = result.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-result");
    expect(toolResult).toMatchObject({ status: "ok", output: "edited p_1" });
  });
});
