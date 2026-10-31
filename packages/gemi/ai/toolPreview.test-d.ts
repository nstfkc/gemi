/**
 * Type-level tests for #1100: a pending call's `preview` is typed by the
 * tool's `approvalPreview`, and `readThread` answers the controller's agent's
 * messages, so neither needs a cast in the app.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import { Agent, AgentTool, type AgentToolShapes, type ToolShapesOf } from "./Agent";
import { AgentController, type AgentRouteRPC } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import type { AgentMessage, PendingToolCall, ToolShapes } from "./types";
import type { UseChatParams } from "./useChat";

/** See `Agent.test-d.ts`: a tuple stops `never` from passing every check. */
type IsNever<T> = [T] extends [never] ? true : false;

type WritePreview = { sql: string; rowsAffected: number };

const executeWrite = AgentTool.create({
  name: "executeWrite",
  description: "Run a write query",
  inputSchema: s.object({ sql: s.string() }),
  outputSchema: s.object({ rowsAffected: s.number() }),
  requiresApproval: true,
  approvalPreview: async (input): Promise<WritePreview> => ({ sql: input.sql, rowsAffected: 3 }),
  execute: async () => ({ rowsAffected: 3 }),
});

const deleteRow = AgentTool.create({
  name: "deleteRow",
  description: "Delete one row",
  inputSchema: s.object({ id: s.string() }),
  outputSchema: s.object({ ok: s.boolean() }),
  requiresApproval: true,
  // Synchronous, and not annotated: the return type is inferred.
  approvalPreview: (input) => ({ id: input.id, table: "orders" }),
  execute: async () => ({ ok: true }),
});

const readRows = AgentTool.create({
  name: "readRows",
  description: "Read rows",
  inputSchema: s.object({ sql: s.string() }),
  outputSchema: s.object({ rows: s.array(s.string()) }),
  requiresApproval: true,
  execute: async () => ({ rows: [] as string[] }),
});

const ask = AgentTool.ask({
  name: "ask",
  description: "Ask the user",
  outputSchema: s.object({ answer: s.string() }),
});

const scoped = Agent.withContext<{ tenantId: string }>().tool({
  name: "scopedWrite",
  description: "A write scoped to the tenant",
  inputSchema: s.object({ sql: s.string() }),
  requiresApproval: true,
  approvalPreview: (input, ctx) => ({ sql: input.sql, tenantId: ctx.context.tenantId }),
  execute: async () => "ok",
});

const dataAgent = Agent.create({
  name: "data",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [executeWrite, deleteRow, readRows, ask],
});

type Shapes = ToolShapesOf<typeof dataAgent.tools>;

class DataChat extends AgentController<typeof dataAgent> {
  agent = dataAgent;
}

/** One route key per test file, named after the file: see `useChat.test-d.ts`. */
declare module "../client/rpc" {
  interface RPC {
    "/tool-preview-test-d": AgentRouteRPC<typeof DataChat>;
  }
}

describe("a tool's preview type", () => {
  test("is inferred from approvalPreview, awaited", () => {
    expectTypeOf<Shapes["executeWrite"]["preview"]>().toEqualTypeOf<WritePreview>();
    expectTypeOf<Shapes["deleteRow"]["preview"]>().toEqualTypeOf<{ id: string; table: string }>();
  });

  test("is `never` for a tool without approvalPreview, and for a client tool", () => {
    expectTypeOf<IsNever<Shapes["readRows"]["preview"]>>().toEqualTypeOf<true>();
    expectTypeOf<IsNever<Shapes["ask"]["preview"]>>().toEqualTypeOf<true>();
  });

  test("is inferred through withContext().tool", () => {
    type Scoped = ToolShapesOf<[typeof scoped]>;
    expectTypeOf<Scoped["scopedWrite"]["preview"]>().toEqualTypeOf<{
      sql: string;
      tenantId: string;
    }>();
  });

  test("leaves the tool's own type unchanged for a tool without one", () => {
    expectTypeOf(readRows).toEqualTypeOf<
      AgentTool<"readRows", { sql: string }, { rows: string[] }>
    >();
  });
});

describe("PendingToolCall.preview", () => {
  test("narrows on the tool's name, with no cast", () => {
    const pending = {} as PendingToolCall<Shapes>;
    if (pending.name === "executeWrite") {
      expectTypeOf(pending.preview).toEqualTypeOf<WritePreview | undefined>();
    }
    if (pending.name === "deleteRow") {
      expectTypeOf(pending.preview).toEqualTypeOf<{ id: string; table: string } | undefined>();
    }
    if (pending.name === "readRows") {
      expectTypeOf<IsNever<NonNullable<typeof pending.preview>>>().toEqualTypeOf<true>();
    }
  });

  test("is `unknown` for a hand-written shapes map that does not say", () => {
    type Legacy = { echo: { input: { text: string }; output: { text: string } } };
    expectTypeOf<Legacy>().toMatchTypeOf<ToolShapes>();
    expectTypeOf<PendingToolCall<Legacy>["preview"]>().toEqualTypeOf<unknown>();
  });

  test("is `unknown` for the untyped default", () => {
    expectTypeOf<PendingToolCall["preview"]>().toEqualTypeOf<unknown>();
  });

  test("reaches useChat's initialPending through the route", () => {
    type Initial = NonNullable<UseChatParams<"/tool-preview-test-d">["initialPending"]>[number];
    const pending = {} as Initial;
    if (pending.name === "executeWrite") {
      expectTypeOf(pending.preview).toEqualTypeOf<WritePreview | undefined>();
    }
  });
});

describe("AgentController.readThread", () => {
  test("answers the controller's agent's messages", () => {
    expectTypeOf(new DataChat().readThread("t")).toEqualTypeOf<
      Promise<AgentMessage<AgentToolShapes<typeof dataAgent>>[] | null>
    >();
  });

  test("goes into useChat's initialMessages with no cast", async () => {
    const messages = await new DataChat().readThread("t");
    const params: UseChatParams<"/tool-preview-test-d"> = { initialMessages: messages ?? [] };
    void params;
  });

  test("still fits an untyped controller, whose messages stay assignable to AgentMessage[]", async () => {
    expectTypeOf<DataChat>().toMatchTypeOf<AgentController>();
    expectTypeOf<DataChat>().toMatchTypeOf<AgentController<any, any>>();
    const untyped: AgentController = new DataChat();
    const loose: AgentMessage[] | null = await untyped.readThread("t");
    const typed: AgentMessage[] | null = await new DataChat().readThread("t");
    void [loose, typed];
  });
});
