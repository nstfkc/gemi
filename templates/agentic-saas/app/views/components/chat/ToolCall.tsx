import type { NestedRun } from "gemi/ai/client";
import {
  BanIcon,
  CheckIcon,
  CornerDownRightIcon,
  Loader2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";

import { Badge } from "@/app/views/components/ui/badge";
import { cn } from "@/app/views/components/lib/utils";

import { Transcript } from "./Transcript";
import {
  formatCents,
  type SupportMessage,
  type SupportToolCall,
  type SupportToolResult,
} from "./types";

/**
 * A call the model made, with everything that arrived while it ran.
 *
 * The narrowing here is the point of the whole typed-route chain: `part.name`
 * is a literal, so `part.input`, `part.progress` and `part.nested` are the
 * tool's own types inside each branch. A tool that cannot yield gets
 * `progress: never[]`, which is what stops anyone writing a progress list for a
 * tool that can never fill one.
 */
export function ToolCall({ part }: { part: SupportToolCall }) {
  return (
    <div className="rounded-lg border bg-card/60 p-3" data-slot="tool-call">
      <div className="flex items-center gap-2 text-xs">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <code className="font-medium">{part.name}</code>
        {part.partial ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            writing arguments
          </span>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground">{callSummary(part)}</span>
        )}
      </div>

      {/*
        A generator tool's `yield`s, in the order they landed. They are appended
        and never rewritten, so this list is safe to render as it grows — and
        `entry.line` is a string rather than `unknown` because `runDiagnostics`
        declares what it yields.
      */}
      {part.name === "runDiagnostics" && part.progress && part.progress.length > 0 ? (
        <ol className="mt-2 space-y-0.5 rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {part.progress.map((entry, index) => (
            <li key={index}>{entry.line}</li>
          ))}
        </ol>
      ) : null}

      {/*
        The sub-agent runs this call drove. Each is an ordinary transcript, so it
        goes back through `Transcript` — the same component rendering the run
        this call sits in.
      */}
      {part.name === "research"
        ? part.nested?.map((run) => <NestedRunBlock key={run.runId} run={run} />)
        : null}
    </div>
  );
}

function NestedRunBlock({ run }: { run: NestedRun }) {
  return (
    <div className="mt-3 rounded-md border border-dashed bg-background/60 p-3">
      <div className="mb-3 flex items-center gap-2 text-xs">
        <CornerDownRightIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{run.label ?? run.agent}</span>
        {run.finishReason ? (
          <Badge variant="outline" className="font-normal">
            {run.finishReason}
          </Badge>
        ) : (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            running
          </span>
        )}
      </div>
      {/*
        A sub-agent's tools are its own, so the framework types this transcript
        with the default tool shapes rather than the support agent's — two
        unrelated types, which is why the cast goes through `unknown`. It only
        decides which names narrow in here; a call this UI has no branch for
        still renders, as the generic row above.
      */}
      <Transcript messages={run.messages as unknown as SupportMessage[]} className="gap-4" />
    </div>
  );
}

/** What a call was asked to do, in one line. Typed reads where the tool is one
 *  this UI knows; the raw input for the rest, which is what a tool pulled out of
 *  the deferred `billing` namespace arrives as. */
function callSummary(part: SupportToolCall) {
  // The arguments are streamed, so a call can be rendered before its input has
  // finished arriving.
  if (!part.input) return "";
  if (part.name === "lookupOrders") return part.input.customerId;
  if (part.name === "orderDetail") return part.input.orderId;
  if (part.name === "runDiagnostics") return part.input.orderId;
  if (part.name === "research") return part.input.question;
  if (part.name === "issueRefund") {
    return `${part.input.orderId} · ${formatCents(part.input.amountCents)} · ${part.input.reason}`;
  }
  return JSON.stringify(part.input);
}

/**
 * The other half of a call.
 *
 * `denied` is a status of its own rather than an error: the model asked for
 * something and did not get it, and whether that was a refusal or a cancel is
 * worth showing, because the next turn reads differently for each.
 */
export function ToolResult({ part }: { part: SupportToolResult }) {
  const failed = part.status === "error";
  const denied = part.status === "denied";

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        failed && "border-destructive/40 bg-destructive/5",
        denied && "bg-muted/40",
      )}
      data-slot="tool-result"
    >
      {failed ? (
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      ) : denied ? (
        <BanIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
      )}
      <div className="min-w-0">
        <code className="font-medium">{part.name}</code>{" "}
        <span className={cn("break-words", failed ? "text-destructive" : "text-muted-foreground")}>
          {resultDetail(part)}
        </span>
      </div>
    </div>
  );
}

function resultDetail(part: SupportToolResult) {
  if (part.status === "error") return `${part.error.code}: ${part.error.message}`;
  if (part.status === "denied") {
    return part.cause === "stopped"
      ? "cancelled while it was running"
      : (part.reason ?? "declined by the operator");
  }

  // `name` first, then `status`: narrowing in that order is what gives
  // `part.output` the tool's own shape instead of `unknown`.
  if (part.name === "lookupOrders" && part.status === "ok") {
    const { orderIds } = part.output;
    return orderIds.length > 0 ? orderIds.join(", ") : "no orders";
  }
  if (part.name === "orderDetail" && part.status === "ok") {
    const { status, totalCents, placedAt } = part.output;
    return `${status} · ${formatCents(totalCents)} · placed ${placedAt}`;
  }
  if (part.name === "issueRefund" && part.status === "ok") {
    return `refund ${part.output.refundId} issued`;
  }
  if (part.name === "runDiagnostics" && part.status === "ok") {
    return `${part.output.checks} checks · ${part.output.summary}`;
  }
  if (part.name === "ask" && part.status === "ok") {
    return part.output.answer;
  }
  if (part.name === "research" && part.status === "ok") {
    return `${part.output.summary} (${part.output.turns} turns)`;
  }
  return JSON.stringify(part.output);
}
