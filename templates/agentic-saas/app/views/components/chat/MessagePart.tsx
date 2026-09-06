import { useState } from "react";
import { BrainIcon, ChevronRightIcon, PaperclipIcon } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/views/components/ui/collapsible";
import { cn } from "@/app/views/components/lib/utils";

import { ToolCall, ToolResult } from "./ToolCall";
import type { SupportPart } from "./types";

/**
 * One content part. The switch is the whole vocabulary a chat UI has to know:
 * anything the agent can produce is one of these six, and a part it does not
 * recognise cannot exist because `AgentContentPart` is a closed union.
 */
export function MessagePart({ part }: { part: SupportPart }) {
  switch (part.type) {
    case "text":
      return <p className="text-sm leading-relaxed whitespace-pre-wrap">{part.text}</p>;
    case "reasoning":
      return <Reasoning text={part.text} />;
    case "file":
      return (
        <div className="flex w-fit items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
          <PaperclipIcon className="size-3.5" />
          {part.name ?? part.fileId}
        </div>
      );
    case "tool-call":
      return <ToolCall part={part} />;
    case "tool-result":
      return <ToolResult part={part} />;
    case "output":
      return (
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
          {JSON.stringify(part.value, null, 2)}
        </pre>
      );
    default:
      return null;
  }
}

/**
 * Reasoning is a part of its own rather than text, so that a UI can render it
 * separately or not at all. Folded in with the answer it would read as the
 * answer; hidden behind a disclosure it is what it is — the model's working,
 * available to anyone curious about how a refund got decided.
 */
function Reasoning({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);

  if (!text) {
    return <p className="text-xs text-muted-foreground">Thought for a moment.</p>;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <BrainIcon className="size-3.5" />
        {open ? "Hide reasoning" : "Show reasoning"}
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l-2 pl-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}
