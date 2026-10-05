import type { AgentJobRecord } from "./AgentJobStore";

/** How many jobs the `<jobs>` block lists by default. */
export const DEFAULT_JOBS_CONTEXT_MAX = 20;

/** `Agent.create({ jobs })`. */
export type AgentJobsOptions = {
  /**
   * The `<jobs>` block added to the system prompt on a thread that has
   * background jobs: at most `max` of them (default 20), running ones first,
   * then the newest settled. `false` leaves it out.
   */
  contextBlock?: { max?: number } | false;
};

const SUMMARY_CHARS = 300;
const ERROR_CHARS = 200;

/**
 * The `<jobs>` block (#461): what the model is told about the thread's
 * background jobs on every turn, beside the tool results in the history.
 *
 * The history already shows each job's call and its `running` or settled
 * result. The block is for what the history cannot show: a job whose result
 * never reached the thread (an orphan), and a list in one place, so a model
 * asked to "make the images" sees that a job for them is already running
 * rather than starting another.
 *
 * Bounded by count, `max`, running before settled and newest first inside
 * each. Times are absolute (UTC) rather than ages, so the block is the same
 * text from one turn to the next until a job starts or settles, and the
 * prompt cache holds in between. `null` when there is nothing to list.
 */
export function renderJobsBlock(jobs: AgentJobRecord[], max: number): string | null {
  if (max <= 0 || jobs.length === 0) return null;
  const newest = (a: AgentJobRecord, b: AgentJobRecord) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
  const listed = [
    ...jobs.filter((job) => job.state === "running").sort(newest),
    ...jobs.filter((job) => job.state !== "running").sort(newest),
  ].slice(0, max);

  const lines = listed.map((job) => {
    const parts = [`- ${job.id} (${job.toolName})`];
    if (job.state === "running") {
      parts.push(`running since ${iso(job.createdAt)}`);
    } else if (job.state === "ok") {
      parts.push(`finished at ${iso(job.settledAt ?? job.updatedAt)}`);
    } else {
      const reason = job.error
        ? `${job.error.code}: ${clip(job.error.message, ERROR_CHARS)}`
        : "failed";
      parts.push(`failed at ${iso(job.settledAt ?? job.updatedAt)} (${reason})`);
    }
    if (job.summary !== undefined)
      parts.push(`summary: ${clip(JSON.stringify(job.summary), SUMMARY_CHARS)}`);
    if (job.orphaned) {
      parts.push("its tool call was lost when the turn that started it was cut short");
    }
    return parts.join("; ");
  });

  return [
    "<jobs>",
    "Background jobs that tools started in this conversation, running ones first. A running job's result replaces its tool result when it finishes. Do not start the same work again while a job for it is running.",
    ...lines,
    "</jobs>",
  ].join("\n");
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}
