/**
 * `Jsonify` and the client's tool types under `strict: true`, as an app
 * compiles them (#1107). See `jsonTypes.strict.test.ts`, which compiles this
 * file and expects no errors: every `expectTypeOf` and `@ts-expect-error`
 * below is a claim, and an unused `@ts-expect-error` is itself an error.
 *
 * Here and not in `jsonTypes.test-d.ts` because the package compiles with
 * `strict: false`, which erases `undefined` from unions, and what happens to
 * an `undefined` member is most of what `JSON.stringify` does to an object.
 */
import { expectTypeOf } from "vitest";

import type { Jsonify } from "../../../utils/jsonify";
import { Agent, AgentTool } from "../../Agent";
import { AgentController, type AgentRouteRPC } from "../../AgentController";
import type { AgentProvider } from "../../AgentProvider";
import { s } from "../../Schema";
import type { JsonToolShapes, PendingToolCall } from "../../types";

// `undefined` members: dropped when always undefined, optional when maybe.
expectTypeOf<
  Jsonify<{ a: string; b: string | undefined; c?: number; d: undefined }>
>().toEqualTypeOf<{
  a: string;
  b?: string;
  c?: number;
}>();

// A function-or-value member may be dropped, so it is optional.
expectTypeOf<Jsonify<{ a: string | (() => void) }>>().toEqualTypeOf<{ a?: string }>();

// In an array, `undefined` and functions are written as `null`.
expectTypeOf<Jsonify<(string | undefined)[]>>().toEqualTypeOf<(string | null)[]>();
expectTypeOf<Jsonify<[Date, undefined]>>().toEqualTypeOf<[string, null]>();

// Readonly tuples keep readonly, with dropped values as `null`.
expectTypeOf<Jsonify<readonly [Date, () => void]>>().toEqualTypeOf<readonly [string, null]>();
expectTypeOf<Jsonify<readonly (Date | undefined)[]>>().toEqualTypeOf<readonly (string | null)[]>();

// `null` survives, in objects and on its own.
expectTypeOf<Jsonify<{ at: Date | null }>>().toEqualTypeOf<{ at: string | null }>();
expectTypeOf<Jsonify<null>>().toEqualTypeOf<null>();

// Nested optional members keep their shape.
expectTypeOf<Jsonify<{ meta?: { at: Date; note?: string } }>>().toEqualTypeOf<{
  meta?: { at: string; note?: string };
}>();

// At the top level `undefined` and `void` stay `undefined`: `JSON.stringify`
// answers `undefined`, and the client gets no value.
type Foo = { at: Date; n: number };
expectTypeOf<Jsonify<Foo | undefined>>().toEqualTypeOf<{ at: string; n: number } | undefined>();
expectTypeOf<Jsonify<string | undefined>>().toEqualTypeOf<string | undefined>();
expectTypeOf<Jsonify<undefined>>().toEqualTypeOf<undefined>();
expectTypeOf<Jsonify<void>>().toEqualTypeOf<undefined>();
expectTypeOf<Jsonify<Foo>>().toEqualTypeOf<{ at: string; n: number }>();

// A `void` member may hold a value, so it is optional, not a required `never`.
expectTypeOf<Jsonify<{ v: void; n: number }>>().toEqualTypeOf<{ v?: never; n: number }>();
// @ts-expect-error not required
const missingVoid: Jsonify<{ v: void; n: number }> extends { v: unknown } ? true : false = true;
void missingVoid;

// An `any` member stays as it is, required.
expectTypeOf<Jsonify<{ a: any; d: Date }>>().toEqualTypeOf<{ a: any; d: string }>();

// @ts-expect-error a member that is always undefined is not there
void ({} as Jsonify<{ a: string; gone: undefined }>).gone;

// The client's pending call, through a route, as `useChat` reads it.
declare const provider: AgentProvider;

const grant = AgentTool.create({
  name: "grant",
  description: "Grant access",
  inputSchema: s.object({ userId: s.string() }),
  requiresApproval: true,
  approvalPreview: async () => ({ expiresAt: new Date(), note: undefined as string | undefined }),
  execute: async () => ({ grantedAt: new Date() }),
});

// A tool that may answer nothing, and one that never answers anything.
const maybe = AgentTool.create({
  name: "maybe",
  description: "May find nothing",
  inputSchema: s.object({ q: s.string() }),
  execute: async (): Promise<Foo | undefined> => undefined,
});

const fireAndForget = AgentTool.create({
  name: "fireAndForget",
  description: "Returns nothing",
  inputSchema: s.object({ q: s.string() }),
  execute: async () => {},
});

const agent = Agent.create({
  name: "strict-json",
  provider,
  tools: [grant, maybe, fireAndForget],
});

class StrictChat extends AgentController<typeof agent> {
  agent = agent;
}

type Tools = AgentRouteRPC<typeof StrictChat>["tools"];

// The missing answer stays possible on the client: a check, not a `Foo`.
expectTypeOf<Tools["maybe"]["output"]>().toEqualTypeOf<{ at: string; n: number } | undefined>();
declare const maybeOutput: Tools["maybe"]["output"];
// @ts-expect-error may be undefined
void maybeOutput.n;
// A tool with no answer is `undefined` on the client, not `never`.
expectTypeOf<Tools["fireAndForget"]["output"]>().toEqualTypeOf<undefined>();

// A hand-written shape: an output that may be missing keeps `undefined`.
type HandWritten = JsonToolShapes<{
  find: {
    input: { q: string };
    output: { at: Date } | undefined;
    progress: { at: Date } | undefined;
  };
}>;
expectTypeOf<HandWritten["find"]["output"]>().toEqualTypeOf<{ at: string } | undefined>();
expectTypeOf<HandWritten["find"]["progress"]>().toEqualTypeOf<{ at: string } | undefined>();

const pending = {} as PendingToolCall<Tools>;
if (pending.name === "grant") {
  expectTypeOf(pending.preview).toEqualTypeOf<{ expiresAt: string; note?: string } | undefined>();
  // @ts-expect-error a string on the client
  pending.preview?.expiresAt.getTime();
}

expectTypeOf<Tools["grant"]["output"]>().toEqualTypeOf<{ grantedAt: string }>();
