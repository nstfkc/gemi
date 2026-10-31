/**
 * Type-level tests for #1107: tool data the browser reads (a pending call's
 * `preview`, a result's `output`, a call's `progress`) is typed as its JSON
 * form, since that is how it travels. Server-side shapes are unchanged.
 *
 * The package compiles with `strict: false`, where `undefined` is erased from
 * unions, so what `Jsonify` does with `undefined` members is checked under
 * `strict: true` in `__fixtures__/json-types/strict.ts` (see
 * `jsonTypes.strict.test.ts`).
 *
 * Run with `bun run test:types`.
 */
import { describe, expectTypeOf, test } from "vitest";

import type { Jsonify } from "../utils/jsonify";
import { Agent, AgentTool, type AgentToolShapes, type ToolShapesOf } from "./Agent";
import { AgentController, type AgentRouteRPC } from "./AgentController";
import { OpenAIProvider } from "./AgentProvider";
import { s } from "./Schema";
import type { AgentMessage, JsonToolShapes, PendingToolCall, ToolResultPart } from "./types";
import type { ChatPendingToolCall, UseChatParams, UseChatResult } from "./useChat";

type IsNever<T> = [T] extends [never] ? true : false;

class Money {
  constructor(
    public cents: number,
    public currency: string,
  ) {}
  toJSON() {
    return { amount: this.cents / 100, currency: this.currency };
  }
}

const grantAccess = AgentTool.create({
  name: "grantAccess",
  description: "Grant access until a date",
  inputSchema: s.object({ userId: s.string() }),
  requiresApproval: true,
  approvalPreview: async (input) => ({
    userId: input.userId,
    expiresAt: new Date(),
    history: [{ at: new Date(), by: "admin" }],
    price: new Money(500, "EUR"),
  }),
  execute: async () => ({ grantedAt: new Date(), ok: true }),
});

const importRows = AgentTool.create({
  name: "importRows",
  description: "Import rows, reporting as it goes",
  inputSchema: s.object({ file: s.string() }),
  execute: async function* () {
    yield { at: new Date(), done: 1 };
    return { finishedAt: new Date(), rows: 1 };
  },
});

const plainWrite = AgentTool.create({
  name: "plainWrite",
  description: "A tool whose data is JSON already",
  inputSchema: s.object({ sql: s.string() }),
  outputSchema: s.object({ rowsAffected: s.number() }),
  requiresApproval: true,
  approvalPreview: () => ({ sql: "update", rows: 3 }),
  execute: async () => ({ rowsAffected: 3 }),
});

const jsonAgent = Agent.create({
  name: "json",
  provider: OpenAIProvider.model("gpt-5.4"),
  tools: [grantAccess, importRows, plainWrite],
});

class JsonChat extends AgentController<typeof jsonAgent> {
  agent = jsonAgent;
}

/** One route key per test file, named after the file: see `useChat.test-d.ts`. */
declare module "../client/rpc" {
  interface RPC {
    "/json-types-test-d": AgentRouteRPC<typeof JsonChat>;
  }
}

type Route = "/json-types-test-d";
type ClientPending = UseChatResult<Route>["pending"][number];
type ClientMessage = UseChatResult<Route>["messages"][number];
type ClientResult = Parameters<NonNullable<UseChatParams<Route>["onToolResult"]>>[0];
type ClientProgress = Parameters<NonNullable<UseChatParams<Route>["onToolProgress"]>>[0];
type ServerShapes = AgentToolShapes<typeof jsonAgent>;

describe("Jsonify", () => {
  test("a Date is a string, nested in objects and arrays", () => {
    expectTypeOf<Jsonify<Date>>().toEqualTypeOf<string>();
    expectTypeOf<Jsonify<{ at: Date; nested: { at: Date; list: Date[] } }>>().toEqualTypeOf<{
      at: string;
      nested: { at: string; list: string[] };
    }>();
    expectTypeOf<Jsonify<{ rows: { at: Date }[] }>>().toEqualTypeOf<{ rows: { at: string }[] }>();
    expectTypeOf<Jsonify<[Date, number]>>().toEqualTypeOf<[string, number]>();
  });

  test("toJSON is honoured", () => {
    expectTypeOf<Jsonify<Money>>().toEqualTypeOf<{ amount: number; currency: string }>();
    expectTypeOf<Jsonify<{ price: Money }>>().toEqualTypeOf<{
      price: { amount: number; currency: string };
    }>();
    expectTypeOf<Jsonify<URL>>().toEqualTypeOf<string>();
  });

  test("functions and symbol keys are dropped", () => {
    const tag = Symbol("tag");
    expectTypeOf<Jsonify<{ id: string; run: () => void; [tag]: number }>>().toEqualTypeOf<{
      id: string;
    }>();
  });

  test("Map and Set arrive empty, bigint cannot be sent", () => {
    expectTypeOf<Jsonify<Map<string, number>>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<Jsonify<Set<number>>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<IsNever<Jsonify<bigint>>>().toEqualTypeOf<true>();
  });

  test("a union is serialised member by member", () => {
    expectTypeOf<Jsonify<{ kind: "a"; at: Date } | { kind: "b"; n: number }>>().toEqualTypeOf<
      { kind: "a"; at: string } | { kind: "b"; n: number }
    >();
  });

  test("index signatures map their values", () => {
    expectTypeOf<Jsonify<Record<string, Date>>>().toEqualTypeOf<{ [key: string]: string }>();
  });

  test("JSON already, any, unknown and never are left as they are", () => {
    type Row = { id: string; tags: string[]; meta: { n: number } | null };
    expectTypeOf<Jsonify<Row>>().toEqualTypeOf<Row>();
    expectTypeOf<Jsonify<any>>().toBeAny();
    expectTypeOf<Jsonify<unknown>>().toEqualTypeOf<unknown>();
    expectTypeOf<IsNever<Jsonify<never>>>().toEqualTypeOf<true>();
  });

  test("a recursive type resolves, at any depth", () => {
    type Tree = { at: Date; label: string; children: Tree[]; parent?: Tree };
    type JsonTree = Jsonify<Tree>;
    expectTypeOf<JsonTree["at"]>().toEqualTypeOf<string>();
    expectTypeOf<JsonTree["children"][number]["children"][number]["at"]>().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<JsonTree["parent"]>["children"][number]["label"]
    >().toEqualTypeOf<string>();
    type List<T> = { value: T; next: List<T> | null };
    expectTypeOf<Jsonify<List<Date>>["next"]>().toEqualTypeOf<Jsonify<List<Date>> | null>();
  });

  test("readonly arrays and tuples keep readonly", () => {
    expectTypeOf<Jsonify<readonly Date[]>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Jsonify<ReadonlyArray<{ x: Date }>>>().toEqualTypeOf<readonly { x: string }[]>();
    expectTypeOf<Jsonify<readonly [Date, number]>>().toEqualTypeOf<readonly [string, number]>();
    expectTypeOf<Jsonify<{ list: readonly Date[] }>>().toEqualTypeOf<{ list: readonly string[] }>();
    // @ts-expect-error still readonly
    (({}) as Jsonify<readonly Date[]>).push("x");
  });

  test("branded strings keep their brand", () => {
    type UserId = string & { readonly __brand: "UserId" };
    expectTypeOf<Jsonify<UserId>>().toEqualTypeOf<UserId>();
    expectTypeOf<Jsonify<{ id: UserId; at: Date }>>().toEqualTypeOf<{ id: UserId; at: string }>();
    expectTypeOf<Jsonify<UserId[]>>().toEqualTypeOf<UserId[]>();
    // @ts-expect-error a plain string is not the brand
    const id: Jsonify<{ id: UserId; at: Date }>["id"] = "u_1";
    void id;
  });

  test("a Date is not what arrives", () => {
    // @ts-expect-error a Date became a string
    const at: Date = {} as Jsonify<{ at: Date }>["at"];
    void at;
    // @ts-expect-error the method was dropped
    void ({} as Jsonify<{ run(): void; id: string }>).run;
  });
});

describe("PendingToolCall.preview on the client", () => {
  test("a preview `{ expiresAt: Date }` is `{ expiresAt: string }`", () => {
    const pending = {} as ClientPending;
    if (pending.name === "grantAccess") {
      expectTypeOf(pending.preview).toEqualTypeOf<
        | {
            userId: string;
            expiresAt: string;
            history: { at: string; by: string }[];
            price: { amount: number; currency: string };
          }
        | undefined
      >();
    }
  });

  test("a JSON preview keeps its type, and a tool without one is still `never`", () => {
    const pending = {} as ClientPending;
    if (pending.name === "plainWrite") {
      expectTypeOf(pending.preview).toEqualTypeOf<{ sql: string; rows: number } | undefined>();
    }
    if (pending.name === "importRows") {
      expectTypeOf<IsNever<NonNullable<typeof pending.preview>>>().toEqualTypeOf<true>();
    }
  });

  test("initialPending takes the same JSON form", () => {
    type Initial = NonNullable<UseChatParams<Route>["initialPending"]>[number];
    expectTypeOf<Initial>().toEqualTypeOf<PendingToolCall<JsonToolShapes<ServerShapes>>>();
    // `pending` is the same call plus `answering` (#1106), and goes back in.
    expectTypeOf<ClientPending>().toEqualTypeOf<
      ChatPendingToolCall<JsonToolShapes<ServerShapes>>
    >();
    expectTypeOf<ClientPending[]>().toMatchTypeOf<Initial[]>();
  });

  test("the input is the schema's, unchanged", () => {
    const pending = {} as ClientPending;
    if (pending.name === "grantAccess") {
      expectTypeOf(pending.input).toEqualTypeOf<ServerShapes["grantAccess"]["input"]>();
    }
  });

  test("calling a Date method on it does not compile", () => {
    const pending = {} as ClientPending;
    if (pending.name === "grantAccess" && pending.preview) {
      // @ts-expect-error `expiresAt` is a string on the client
      pending.preview.expiresAt.getTime();
    }
  });
});

describe("output and progress on the client", () => {
  test("onToolResult's output is the JSON form", () => {
    const part = {} as ClientResult;
    if (part.name === "grantAccess" && part.status === "ok") {
      expectTypeOf(part.output).toEqualTypeOf<{ grantedAt: string; ok: boolean }>();
    }
    if (part.name === "importRows" && part.status === "ok") {
      expectTypeOf(part.output).toEqualTypeOf<{ finishedAt: string; rows: number }>();
    }
    if (part.name === "plainWrite" && part.status === "ok") {
      expectTypeOf(part.output).toEqualTypeOf<{ rowsAffected: number }>();
    }
  });

  test("onToolProgress's data and a call's progress log are the JSON form", () => {
    const progress = {} as ClientProgress;
    if (progress.name === "importRows") {
      expectTypeOf(progress.data).toEqualTypeOf<{ at: string; done: number }>();
    }
    const message = {} as ClientMessage;
    const part = message.content[0]!;
    if (part.type === "tool-call" && part.name === "importRows") {
      expectTypeOf(part.progress).toEqualTypeOf<{ at: string; done: number }[] | undefined>();
    }
  });

  test("a Date method on an output does not compile", () => {
    const part = {} as ClientResult;
    if (part.name === "grantAccess" && part.status === "ok") {
      // @ts-expect-error `grantedAt` is a string on the client
      part.output.grantedAt.getTime();
    }
  });
});

describe("the server keeps the tools' own types", () => {
  test("ToolShapesOf and AgentToolShapes are unchanged", () => {
    expectTypeOf<ServerShapes["grantAccess"]["output"]>().toEqualTypeOf<{
      grantedAt: Date;
      ok: boolean;
    }>();
    expectTypeOf<ToolShapesOf<typeof jsonAgent.tools>["importRows"]["progress"]>().toEqualTypeOf<{
      at: Date;
      done: number;
    }>();
  });

  test("a server-side part over the agent's shapes still has the Date", () => {
    const part = {} as ToolResultPart<ServerShapes>;
    if (part.name === "grantAccess" && part.status === "ok") {
      expectTypeOf(part.output.grantedAt).toEqualTypeOf<Date>();
    }
    const pending = {} as PendingToolCall<ServerShapes>;
    if (pending.name === "grantAccess" && pending.preview) {
      expectTypeOf(pending.preview.expiresAt).toEqualTypeOf<Date>();
    }
  });

  test("the route's tools are the JSON form of the agent's", () => {
    expectTypeOf<AgentRouteRPC<typeof JsonChat>["tools"]>().toEqualTypeOf<
      JsonToolShapes<ServerShapes>
    >();
  });
});

describe("readThread", () => {
  test("answers the JSON form, and goes into useChat with no cast", async () => {
    const messages = await new JsonChat().readThread("t");
    expectTypeOf(messages).toEqualTypeOf<AgentMessage<JsonToolShapes<ServerShapes>>[] | null>();
    const params: UseChatParams<Route> = { initialMessages: messages ?? [] };
    void params;
  });

  test("is not the server-side message type when a tool's data has a Date", async () => {
    const messages = await new JsonChat().readThread("t");
    // @ts-expect-error `grantedAt` is a string in the stored thread, not a Date
    const server: AgentMessage<ServerShapes>[] | null = messages;
    void server;
  });

  test("server-side messages do not go into useChat when a tool's data has a Date", () => {
    const server = [] as AgentMessage<ServerShapes>[];
    // @ts-expect-error the client holds strings where the server had Dates
    const params: UseChatParams<Route> = { initialMessages: server };
    void params;
  });
});
