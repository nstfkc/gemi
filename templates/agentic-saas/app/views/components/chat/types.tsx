import type { UseChatResult } from "gemi/ai/client";

/**
 * The shapes this directory narrows on, read off the hook instead of restated.
 *
 * `useChat("/support")` resolves the agent's tools through the route's `RPC`
 * entry, so taking the message type back out of `UseChatResult` is what gives
 * `part.name === "runDiagnostics"` a `progress` of `{ line: string }[]` in a
 * component that never sees the tool. Writing the same shapes out by hand would
 * compile just as well and go quietly stale the first time a tool's schema
 * changes — which is the one failure a chat UI cannot see, because a wrong type
 * still renders.
 *
 * No JSX below; the file is `.tsx` only because the whole directory is.
 */
type SupportChat = UseChatResult<"/support">;

export type SupportMessage = SupportChat["messages"][number];
export type SupportPart = SupportMessage["content"][number];
export type SupportToolCall = Extract<SupportPart, { type: "tool-call" }>;
export type SupportToolResult = Extract<SupportPart, { type: "tool-result" }>;
export type SupportPending = SupportChat["pending"][number];

/** Signatures taken from the hook so a panel cannot drift from what answers it. */
export type Approve = SupportChat["approve"];
export type Answer = SupportChat["answer"];

/** Cents are integers on the wire, and `toLocaleString` without a fixed locale
 *  renders differently on the server than in the browser. */
export function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
