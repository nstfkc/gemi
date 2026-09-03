import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { SendIcon, SquareIcon } from "lucide-react";

import { Button } from "@/app/views/components/ui/button";
import { Textarea } from "@/app/views/components/ui/textarea";

/**
 * The composer, and the stop button that lives with it.
 *
 * `stop` is on this row rather than up in the header because a closed tab no
 * longer ends a run — the button is the only thing that does, so it belongs
 * where the user's hands already are.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  hint,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  hint?: string;
}) {
  const [text, setText] = useState("");

  function submit() {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    setText("");
    onSend(trimmed);
  }

  return (
    <div className="border-t bg-background p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            rows={2}
            placeholder="Ask about an order, a refund, an invoice…"
            className="max-h-40 min-h-[2.75rem] resize-none"
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              // Enter sends, shift+enter breaks the line — the shape everyone
              // already has in their fingers.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <Button variant="outline" size="icon" onClick={onStop} aria-label="Stop the run">
              <SquareIcon />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={text.trim().length === 0}
              aria-label="Send"
            >
              <SendIcon />
            </Button>
          )}
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}
