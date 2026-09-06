import type { AgentError } from "gemi/ai/client";
import { TriangleAlertIcon } from "lucide-react";

import { Button } from "@/app/views/components/ui/button";

/**
 * A failure the run could not absorb.
 *
 * `retryable` is the server's judgement, not a guess made here: a rate limit or
 * a 5xx is worth another go, an invalid tool result is not, and offering retry
 * on the second kind trains people to click it on the first failure that will
 * never clear.
 */
export function ErrorBanner({ error, onRetry }: { error: AgentError; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">{error.message}</p>
        <p className="text-xs text-muted-foreground">{error.code}</p>
      </div>
      {error.retryable ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
