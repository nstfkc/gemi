/**
 * Type-level tests for #1100: a pending call's `preview` is typed by the
 * tool's `approvalPreview`, and `readThread` answers the controller's agent's
 * messages, so neither needs a cast in the app.
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import {
  Agent,
  AgentTool,
  type AgentContext,
  type AgentToolShapes,
  type AnyAgentTool,
  type ToolShapesOf,
} from "./Agent";
import { AgentController, type AgentRouteRPC } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import type { AgentMessage, PendingToolCall, ToolShapes } from "./types";
import type { ChatPendingToolCall, UseChatParams, UseChatResult } from "./useChat";

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

  test("is `never` on the tool's own type for a tool without one", () => {
    expectTypeOf(readRows).toEqualTypeOf<
      AgentTool<"readRows", { sql: string }, { rows: string[] }, never, AgentContext, never>
    >();
    expectTypeOf(ask).toEqualTypeOf<
      AgentTool<"ask", { question: string }, { answer: string }, never, unknown, never>
    >();
  });
});

describe("tool types written out by hand", () => {
  test("a five-argument AgentTool still holds a tool with a preview", () => {
    // The class's own `Preview` defaults to `unknown`, so the pre-#1100
    // spelling of "any tool" keeps accepting every tool.
    const anyTool: AgentTool<string, any, any, any, any> = executeWrite;
    const anyTool6: AnyAgentTool = executeWrite;
    const typed: AgentTool<"executeWrite", { sql: string }, { rowsAffected: number }> =
      executeWrite;
    void [anyTool, anyTool6, typed];
  });

  test("explicit type arguments without Preview still accept an approvalPreview", () => {
    const explicit = AgentTool.create<"explicit", { sql: string }, number, never, AgentContext>({
      name: "explicit",
      description: "Explicit type arguments",
      inputSchema: s.object({ sql: s.string() }),
      requiresApproval: true,
      approvalPreview: (input) => ({ sql: input.sql }),
      execute: async () => 1,
    });
    // Nothing infers it there, so it is the default.
    expectTypeOf<IsNever<ToolShapesOf<[typeof explicit]>["explicit"]["preview"]>>().toEqualTypeOf<true>();

    const viaKit = Agent.withContext<{ tenantId: string }>().tool<
      "viaKit",
      { sql: string },
      number,
      never
    >({
      name: "viaKit",
      description: "Explicit type arguments through withContext",
      inputSchema: s.object({ sql: s.string() }),
      requiresApproval: true,
      approvalPreview: (input) => ({ sql: input.sql }),
      execute: async () => 1,
    });

    const withPreview = AgentTool.create<
      "withPreview",
      { sql: string },
      number,
      never,
      AgentContext,
      { sql: string }
    >({
      name: "withPreview",
      description: "Explicit Preview",
      inputSchema: s.object({ sql: s.string() }),
      requiresApproval: true,
      approvalPreview: (input) => ({ sql: input.sql }),
      execute: async () => 1,
    });
    expectTypeOf<ToolShapesOf<[typeof withPreview]>["withPreview"]["preview"]>().toEqualTypeOf<{
      sql: string;
    }>();

    AgentTool.create<"wrongPreview", { sql: string }, number, never, AgentContext, { sql: string }>({
      name: "wrongPreview",
      description: "A preview of the wrong type",
      inputSchema: s.object({ sql: s.string() }),
      requiresApproval: true,
      // @ts-expect-error the explicit Preview is `{ sql: string }`
      approvalPreview: () => ({ rows: 1 }),
      execute: async () => 1,
    });
    void viaKit;
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

describe("useChat's pending (#1106)", () => {
  type Held = UseChatResult<"/tool-preview-test-d">["pending"][number];

  test("carries an optional answering flag and still narrows on name", () => {
    const pending = {} as Held;
    expectTypeOf(pending.answering).toEqualTypeOf<boolean | undefined>();
    if (pending.name === "executeWrite") {
      expectTypeOf(pending.preview).toEqualTypeOf<WritePreview | undefined>();
    }
  });

  test("is a PendingToolCall, so it goes back into initialPending", () => {
    expectTypeOf<Held>().toMatchTypeOf<PendingToolCall<Shapes>>();
    expectTypeOf<Held[]>().toMatchTypeOf<
      NonNullable<UseChatParams<"/tool-preview-test-d">["initialPending"]>
    >();
    expectTypeOf<ChatPendingToolCall<Shapes>>().toEqualTypeOf<Held>();
  });

  test("answering is a boolean", () => {
    const pending = {} as Held;
    // @ts-expect-error not a string
    const wrong: string = pending.answering;
    void wrong;
  });
});

describe("AgentController.readThread", () => {
  test("answers the controller's agent's messages", () => {
    expectTypeOf<Awaited<ReturnType<DataChat["readThread"]>>>().toEqualTypeOf<
      AgentMessage<AgentToolShapes<typeof dataAgent>>[] | null
    >();
  });

  test("goes into useChat's initialMessages with no cast", async () => {
    const messages = await new DataChat().readThread("t");
    const params: UseChatParams<"/tool-preview-test-d"> = { initialMessages: messages ?? [] };
    void params;
  });

  test("a controller still fits the untyped bounds", async () => {
    expectTypeOf<DataChat>().toMatchTypeOf<AgentController>();
    expectTypeOf<DataChat>().toMatchTypeOf<AgentController<any, any>>();
    const untyped: AgentController = new DataChat();
    // An unknown agent answers `AgentMessage<any>`, which fits as before.
    const loose: AgentMessage[] | null = await untyped.readThread("t");
    void loose;
  });

  test("a typed answer is not an untyped AgentMessage[], as any typed message is not", async () => {
    // `AgentMessage` is invariant in its tool shapes, on purpose (see below).
    // @ts-expect-error a typed message is not `AgentMessage<ToolShapes>`
    const typed: AgentMessage[] | null = await new DataChat().readThread("t");
    void typed;
  });
});

describe("AgentMessage's tool shapes", () => {
  type S = { input: { x: string }; output: number };

  test("a message of an agent with more tools does not fit a narrower agent's", () => {
    // Its parts can name a tool the narrower side does not handle.
    const wide = {} as AgentMessage<{ a: S; b: S; c: S }>;
    // @ts-expect-error the extra tool `c`
    const narrow: AgentMessage<{ a: S; b: S }> = wide;
    void narrow;
  });

  test("a message with a wider output does not fit a narrower one", () => {
    const wide = {} as AgentMessage<{ a: S }>;
    // @ts-expect-error `number` is not `1`
    const narrow: AgentMessage<{ a: { input: { x: string }; output: 1 } }> = wide;
    void narrow;
  });

  test("a message of an unrelated tool does not fit", () => {
    const other = {} as AgentMessage<{ z: S }>;
    // @ts-expect-error no tool `z` on the target
    const target: AgentMessage<{ a: S }> = other;
    void target;
  });

  test("a superset agent's readThread does not go into a narrower route's useChat", async () => {
    const wider = Agent.create({
      name: "wider",
      provider: OpenAIProvider.model("gpt-5.4"),
      tools: [executeWrite, deleteRow, readRows, ask, scoped],
    });
    class WiderChat extends AgentController<typeof wider> {
      agent = wider;
    }
    const messages = (await new WiderChat().readThread("t")) ?? [];
    // @ts-expect-error `scopedWrite` is not a tool of the route's agent
    const params: UseChatParams<"/tool-preview-test-d"> = { initialMessages: messages };
    void params;
  });
});
