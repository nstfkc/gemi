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

/**
 * The yielding form. `Progress` is inferred from the generator and written down
 * nowhere, which is the property the tests below are really about — an app
 * declares what a tool yields by yielding it.
 */
const buildPage = AgentTool.create({
  name: "buildPage",
  description: "Build a page, one section at a time",
  inputSchema: s.object({ id: s.string() }),
  outputSchema: s.object({ ok: s.boolean() }),
  execute: async function* (input: { id: string }) {
    yield { section: "hero", of: 2 };
    yield { section: "pricing", of: 2 };
    return { ok: Boolean(input.id) };
  },
});

const pageAgent = Agent.create({
  name: "page-builder",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [editComponent, renamePage],
});

class PageBuilderController extends AgentController<typeof pageAgent> {
  agent = pageAgent;
}

/**
 * A second agent rather than a third tool on the first one.
 *
 * `onToolResult`'s assertions below name the exact union of `pageAgent`'s tool
 * names, so adding a yielding tool there would have made those tests fail for a
 * reason that has nothing to do with what they check.
 */
const progressAgent = Agent.create({
  name: "page-progress",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [buildPage, renamePage],
});

class PageProgressController extends AgentController<typeof progressAgent> {
  agent = progressAgent;
}

/**
 * ONE ROUTE KEY PER TEST FILE, AND NOT A PLAUSIBLE ONE.
 *
 * This augmentation is global to the program, not local to this file, so two
 * test files declaring the same key are two declarations of one property —
 * `TS2717`, with a message that prints the two types identically because the
 * classes behind them merely share a name. The follow-on errors land in
 * `expectTypeOf` assertions and read as though the narrowing broke.
 *
 * It costs nothing to avoid and is confusing to diagnose, so the key names the
 * file rather than the thing: `/page-builder` is what a second test file would
 * also have picked.
 *
 * Two keys in *this* file is not the same thing and is fine — the clash is
 * between files, and one interface may declare as many properties as it likes.
 */
declare module "../client/rpc" {
  interface RPC {
    "/on-tool-result": AgentRouteRPC<typeof PageBuilderController>;
    "/on-tool-progress": AgentRouteRPC<typeof PageProgressController>;
  }
}

type OnToolResult = NonNullable<UseChatParams<"/on-tool-result">["onToolResult"]>;
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

type OnToolProgress = NonNullable<UseChatParams<"/on-tool-progress">["onToolProgress"]>;
type Progress = Parameters<OnToolProgress>[0];

describe("onToolProgress", () => {
  test("is discriminated by tool name, like a result", () => {
    expectTypeOf<Progress["name"]>().toEqualTypeOf<"buildPage" | "renamePage">();
  });

  test("narrows `data` to what that tool yields, inferred from the generator", () => {
    const handler: OnToolProgress = (progress) => {
      if (progress.name === "buildPage") {
        expectTypeOf(progress.data).toEqualTypeOf<{ section: string; of: number }>();
      }
    };
    void handler;
  });

  test("a tool that cannot yield has `never` to yield", () => {
    // `renamePage`'s `execute` returns a promise, so there is no yield type to
    // infer and `Progress` lands on `never`. Worth asserting rather than
    // assuming: the alternative a conditional type would have produced is a
    // missing member, which under this package's `strict: false` is
    // indistinguishable from an optional one — see `ToolShapesOf`.
    const handler: OnToolProgress = (progress) => {
      if (progress.name === "renamePage") {
        expectTypeOf(progress.data).toEqualTypeOf<never>();
      }
    };
    void handler;
  });

  test("refuses a tool the agent does not have", () => {
    const handler: OnToolProgress = (progress) => {
      // @ts-expect-error `editComponent` belongs to the other agent.
      if (progress.name === "editComponent") return;
    };
    void handler;
  });

  test("carries the call id, so several calls of one tool stay apart", () => {
    const handler: OnToolProgress = (progress) => {
      expectTypeOf(progress.toolCallId).toEqualTypeOf<string>();
    };
    void handler;
  });
});
