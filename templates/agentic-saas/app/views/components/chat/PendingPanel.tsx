import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { CircleHelpIcon, ShieldQuestionIcon } from "lucide-react";

import { Badge } from "@/app/views/components/ui/badge";
import { Button } from "@/app/views/components/ui/button";
import { Input } from "@/app/views/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/app/views/components/ui/card";

import { formatCents, type Answer, type Approve, type SupportPending } from "./types";

/**
 * Everything the run is waiting on a person for.
 *
 * One list, because an approval and a question differ only in who produces the
 * result — not in how the conversation carries it. Both are answered by a plain
 * call taking the tool call's id: the signature that makes an answer
 * unforgeable, and the `path` that says which nested tool call to re-enter, are
 * carried by the hook and handed back untouched.
 */
export function PendingPanel({
  pending,
  approve,
  answer,
}: {
  pending: SupportPending[];
  approve: Approve;
  answer: Answer;
}) {
  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {pending.map((call) => (
        <PendingCard key={call.toolCallId} call={call} approve={approve} answer={answer} />
      ))}
    </div>
  );
}

function PendingCard({
  call,
  approve,
  answer,
}: {
  call: SupportPending;
  approve: Approve;
  answer: Answer;
}) {
  const [draft, setDraft] = useState("");

  /*
    A question raised by the research agent arrives in this same list, with
    `path` naming the chain of tool calls it is nested under. It is read here
    only to say who is asking — answering it is the identical call, and a UI
    that tried to route on the path would be re-deriving something the
    signature already commits to.
  */
  const asker = call.path && call.path.length > 0 ? "the research agent" : "the support agent";

  if (call.kind === "question") {
    return (
      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <CircleHelpIcon className="size-4" />
            {asker} needs an answer
          </CardTitle>
          {/* `ask` declares a one-field input, so the question itself is typed. */}
          <CardDescription>
            {call.name === "ask" ? call.input.question : "Answer to continue."}
          </CardDescription>
        </CardHeader>
        <CardFooter className="gap-2">
          <Input
            value={draft}
            autoFocus
            placeholder="Type your answer"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter" && draft.trim()) {
                // The output is checked against the tool's own output schema
                // server-side before the model sees it, so the shape here is
                // `ask`'s `{ answer: string }` and not free-form.
                void answer(call.toolCallId, { answer: draft.trim() });
              }
            }}
          />
          <Button
            disabled={draft.trim().length === 0}
            onClick={() => void answer(call.toolCallId, { answer: draft.trim() })}
          >
            Answer
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="border-amber-500/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldQuestionIcon className="size-4" />
          {asker} wants to run <code>{call.name}</code>
        </CardTitle>
        <CardDescription>
          It will not run until someone here says so, and the decision is signed — approving it
          approves exactly the input below.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {call.name === "issueRefund" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Order</dt>
            <dd className="font-medium">{call.input.orderId}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-medium">{formatCents(call.input.amountCents)}</dd>
            <dt className="text-muted-foreground">Reason</dt>
            <dd>{call.input.reason}</dd>
          </dl>
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs">
            {JSON.stringify(call.input, null, 2)}
          </pre>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={() => void approve(call.toolCallId, true)}>Approve</Button>
        <Button variant="outline" onClick={() => void approve(call.toolCallId, false, "declined")}>
          Deny
        </Button>
        <Badge variant="secondary" className="ml-auto font-normal">
          {call.kind}
        </Badge>
      </CardFooter>
    </Card>
  );
}
