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

// `null` survives, in objects and on its own.
expectTypeOf<Jsonify<{ at: Date | null }>>().toEqualTypeOf<{ at: string | null }>();
expectTypeOf<Jsonify<null>>().toEqualTypeOf<null>();

// Nested optional members keep their shape.
expectTypeOf<Jsonify<{ meta?: { at: Date; note?: string } }>>().toEqualTypeOf<{
  meta?: { at: string; note?: string };
}>();

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

const agent = Agent.create({ name: "strict-json", provider, tools: [grant] });

class StrictChat extends AgentController<typeof agent> {
  agent = agent;
}

type Tools = AgentRouteRPC<typeof StrictChat>["tools"];
expectTypeOf<Tools>().toEqualTypeOf<JsonToolShapes<{ grant: Tools["grant"] }>>();

const pending = {} as PendingToolCall<Tools>;
if (pending.name === "grant") {
  expectTypeOf(pending.preview).toEqualTypeOf<{ expiresAt: string; note?: string } | undefined>();
  // @ts-expect-error a string on the client
  pending.preview?.expiresAt.getTime();
}

expectTypeOf<Tools["grant"]["output"]>().toEqualTypeOf<{ grantedAt: string }>();
