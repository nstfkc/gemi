import { Avatar, AvatarFallback } from "@/app/views/components/ui/avatar";
import { Badge } from "@/app/views/components/ui/badge";
import { cn } from "@/app/views/components/lib/utils";
import { BotIcon } from "lucide-react";

import { MessagePart } from "./MessagePart";
import type { SupportMessage, SupportPart } from "./types";

/**
 * One run, rendered.
 *
 * This component is deliberately the only one in the template that knows what a
 * transcript looks like. A sub-agent's run arrives on `ToolCallPart.nested` as
 * an ordinary `AgentMessage[]`, so `ToolCall` renders it by calling straight
 * back into here — depth costs nothing and there is no second renderer to keep
 * in step with this one. That is also why the props are the messages and
 * nothing else: anything the outer chat holds and a nested run does not (a
 * status, a composer, pending calls) would have to be faked one level down.
 */
export function Transcript({
  messages,
  className,
}: {
  messages: SupportMessage[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)} data-slot="transcript">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </div>
  );
}

/**
 * A tool call and its result are two parts that belong to each other, and the
 * only thing tying them together is the id — so it, not the array position, is
 * the key. Text and reasoning have nothing stable, and index is honest for
 * them: they are appended to and never reordered.
 */
function partKey(part: SupportPart, index: number) {
  if (part.type === "tool-call" || part.type === "tool-result") {
    return `${part.type}:${part.toolCallId}`;
  }
  return `${part.type}:${index}`;
}

function MessageRow({ message }: { message: SupportMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.content.map((part, index) => (
            <MessagePart key={partKey(part, index)} part={part} />
          ))}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <p className="text-center text-xs text-muted-foreground">
        {message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ")}
      </p>
    );
  }

  return (
    <div className="flex gap-3">
      <Avatar className="mt-0.5 size-7 shrink-0">
        <AvatarFallback className="bg-muted text-muted-foreground">
          <BotIcon className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {message.content.map((part, index) => (
          <MessagePart key={partKey(part, index)} part={part} />
        ))}
        <FinishNote message={message} />
      </div>
    </div>
  );
}

/**
 * Why a turn ended, on the two endings a reader would otherwise misread.
 *
 * `max-steps` is not an error and it is also not a finished answer — the agent
 * ran out of steps mid-task — and `aborted` keeps the text it had already
 * produced, so without a marker a turn cut off by the stop button reads as one
 * that simply stopped talking. Everything else ("stop") needs no announcement.
 */
function FinishNote({ message }: { message: SupportMessage }) {
  if (message.finishReason === "max-steps") {
    return (
      <Badge variant="outline" className="w-fit text-muted-foreground">
        Stopped at the step limit
      </Badge>
    );
  }
  if (message.finishReason === "aborted") {
    return (
      <Badge variant="outline" className="w-fit text-muted-foreground">
        Interrupted
      </Badge>
    );
  }
  return null;
}
