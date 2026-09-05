import { SearchIcon } from "lucide-react";

/**
 * What the model has pulled out of the deferred `billing` namespace so far.
 *
 * A deferred namespace withholds its schemas until the model goes looking, and
 * that search is a step of its own — from the outside it is a pause with
 * nothing streaming, which reads as a hang. This line is what the pause is for.
 *
 * Run-scoped, not part of the transcript: it is empty again on the next run, so
 * it is never persisted beside the messages.
 */
export function LoadedTools({ tools }: { tools: string[] }) {
  if (tools.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <SearchIcon className="size-3.5 animate-pulse" />
      Looking for the right tool — loaded <code>{tools.join(", ")}</code>
    </div>
  );
}
