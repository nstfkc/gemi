import { useEffect, useState } from "react";

import {
  type EachProgress,
  type WorkflowStepStatus,
  type WorkflowUpdate,
  workflowEnded,
} from "../services/queue/workflow/wire";
import type { GetRPC } from "./useQuery";
import {
  type SubscriptionOptions,
  type SubscriptionStatus,
  useSubscription,
} from "./useSubscription";

export type { EachProgress, WorkflowStepStatus, WorkflowUpdate };

export type UseWorkflowConfig = {
  /**
   * The workflow as the view read it (`Workflow.find`, or the route's
   * data), shown until the first update arrives. Its `args` and `result`
   * are not needed; pass `null` when the view has none yet.
   */
  initial?: WorkflowUpdate | null;
  /**
   * Where to start, from `Workflow.cursor(id)` read with `initial`, so an
   * update between the render and the connection is not missed.
   */
  cursor?: string | null;
  /** `false` disconnects. Default `true`. It also disconnects once the workflow has ended. */
  enabled?: boolean;
  /** Disconnect while the tab is hidden, and catch up once shown. Default `true`. */
  pauseWhenHidden?: boolean;
  /**
   * The stream could not catch up update by update (it was away longer than
   * the feed keeps changes). The next update brings the whole status again;
   * re-read the view's data here when the workflow may have ended meanwhile.
   */
  onReset?: () => void;
};

/**
 * Follows a workflow through a route that answers with `Workflow.stream`,
 * and returns its latest status: `progress`, `status`, `currentStep`, and
 * each step's own `progress` and `items` (a `step.each`).
 *
 * ```tsx
 * const { workflow } = useWorkflow(
 *   "/imports/:importId/progress",
 *   { params: { importId } },
 *   { initial: data.workflow, cursor: data.workflowCursor },
 * );
 * const rows = workflow?.steps.find((step) => step.key === "rows")?.items;
 * ```
 *
 * Of two updates it keeps the later one (by `updatedAt`), so updates that
 * two instances published out of order cannot move it backwards. Once the
 * workflow has ended, it disconnects.
 */
export function useWorkflow<T extends keyof GetRPC>(
  url: T,
  options: SubscriptionOptions<T> = {},
  config: UseWorkflowConfig = {},
): {
  workflow: WorkflowUpdate | null;
  status: SubscriptionStatus;
  error: Error | null;
} {
  const [workflow, setWorkflow] = useState<WorkflowUpdate | null>(config.initial ?? null);

  // A newer status the view hands over (it re-read the data) wins too.
  useEffect(() => {
    if (config.initial) setWorkflow((current) => later(current, config.initial!));
  }, [config.initial]);

  const ended = workflow !== null && workflowEnded(workflow.status);
  const subscription = useSubscription(url, options, {
    cursor: config.cursor ?? null,
    enabled: config.enabled !== false && !ended,
    pauseWhenHidden: config.pauseWhenHidden,
    onChange: ({ data }) => {
      const update = data as WorkflowUpdate | null;
      if (!update || typeof update !== "object" || typeof update.updatedAt !== "number") return;
      setWorkflow((current) => later(current, update));
    },
    onReset: () => config.onReset?.(),
  });

  return { workflow, status: subscription.status, error: subscription.error };
}

function later(current: WorkflowUpdate | null, next: WorkflowUpdate): WorkflowUpdate {
  if (!current || current.id !== next.id) return next;
  return next.updatedAt >= current.updatedAt ? next : current;
}
