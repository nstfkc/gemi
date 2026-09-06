/**
 * Type-level tests for the browser half.
 *
 * `Agent.test-d.ts` pins that a tool's progress type survives `ToolShapesOf`
 * and lands on `ToolCallPart`. What is left, and what belongs here, is that it
 * survives the *reducer's* generics — `ChatState<T, O>` carries `T` down
 * through `AgentMessage` into a content part — because that is the last link
 * between a tool's `execute` and the component that renders its progress log,
 * and it is entirely made of mapped types no runtime test touches.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";
import type { AgentMessage, NestedRun } from "../types";
import type { UseChatResult } from "../useChat";
import type { ChatState } from "./reducer";

type Shapes = {
  research: {
    input: { topic: string };
    output: { summary: string };
    progress: { stage: string };
  };
  bash: { input: { command: string }; output: { output: string }; progress: never };
};

type Part = ChatState<Shapes>["messages"][number]["content"][number];

describe("what a component gets out of the reducer's state", () => {
  test("a tool call's progress log is typed by the tool, not by `unknown`", () => {
    const part = {} as Part;
    if (part.type === "tool-call" && part.name === "research") {
      expectTypeOf(part.progress).toEqualTypeOf<{ stage: string }[] | undefined>();
      expectTypeOf(part.input).toEqualTypeOf<{ topic: string }>();
    }
  });

  test("a tool that cannot yield gets a progress log it cannot fill", () => {
    // `never[]`, not `unknown[]`: a UI that maps over this has nothing to
    // narrow, which is the correct amount of work for a tool with no yields.
    const part = {} as Part;
    if (part.type === "tool-call" && part.name === "bash") {
      expectTypeOf(part.progress).toEqualTypeOf<never[] | undefined>();
    }
  });

  test("a nested run is a transcript, so it renders with the message renderer", () => {
    const part = {} as Part;
    if (part.type === "tool-call") {
      expectTypeOf(part.nested).toEqualTypeOf<NestedRun[] | undefined>();
      // The claim that makes the recursion worth anything: what comes out of a
      // nested run is assignable to the argument of a component written against
      // the top-level transcript.
      const render = (_messages: AgentMessage[]) => {};
      expectTypeOf(render).toBeCallableWith({} as NestedRun["messages"]);
    }
  });

  test("a sub-agent's transcript is not typed with the parent's tools", () => {
    // A parent's tool shapes say nothing about what its children can call, so
    // `NestedRun.messages` stays at the default shapes. Asserting the negative
    // because the tempting mistake — threading `T` down into `nested` — would
    // compile and would name every sub-agent's tools after the parent's.
    expectTypeOf<NestedRun["messages"]>().toEqualTypeOf<AgentMessage[]>();
    expectTypeOf<NestedRun["messages"]>().not.toEqualTypeOf<AgentMessage<Shapes>[]>();
  });
});

/**
 * The upload half of the hook's surface, which only a type test can hold.
 *
 * `attach` is a declaration over a `fetch` — the runtime already returns
 * whatever the route sent, so a runtime test cannot tell whether the declared
 * type still matches it. It drifted once already: the route grew `attachmentId`
 * and started answering without a `fileId`, and this member still said
 * `Promise<{ fileId: string; ... }>`. In-repo `tsc` cannot catch that either,
 * because `packages/typescript-config/base.json` sets `strict: false`, so the
 * implementation's `string | undefined` is assignable to the declared `string`
 * at the `attach: uploadFile` assignment. What the lie costs is paid in an app:
 * `const { fileId } = await attach(f)` typechecks, `fileId` is `undefined` for a
 * storage-only upload, and `file_id: undefined` goes to the vendor. So the
 * shape is asserted here, where equality is exact and optionality is part of it.
 */
describe("what `attach` promises the caller", () => {
  test("both ids are optional, because either can be genuinely absent", () => {
    type Attached = Awaited<ReturnType<UseChatResult<never>["attach"]>>;

    expectTypeOf<Attached>().toEqualTypeOf<{
      fileId?: string;
      attachmentId?: string;
      name: string;
      mimeType: string;
      downgraded?: "no_scope";
    }>();
  });
});
