import type { Schema } from "../Schema";
import type { AgentJobRef, AgentMessage, ToolResultPart } from "../types";
import type { AgentJobRecord, AgentJobState, AgentJobStore } from "./AgentJobStore";

/** How many of a thread's newest jobs are checked for orphans on each load. */
const ORPHAN_SCAN = 50;

const ANY_STATE: AgentJobState[] = ["running", "ok", "error"];

/**
 * The thread with each background job's current state rendered over the tool
 * result that points at it (#461).
 *
 * A tool that returned a `JobHandle` left a `running` result in the thread.
 * The job settles later, into the job store, and never into the messages: a
 * live run writes whole messages, and a settle racing those writes would be
 * overwritten by the run's stale copy. So the messages are brought up to date
 * here, when the thread is loaded, which `AgentController` does under the
 * thread's lock before a turn and without writing for `readThread`.
 *
 * - A `running` result whose job settled becomes the job's `ok` or `error`
 *   result, in place, with the job still named on it (`job`).
 * - A `running` result whose job is still running is left exactly as it is,
 *   so the request stays byte-identical, and the prompt cache with it, until
 *   the job settles.
 * - A `running` result whose job the store does not have becomes an `error`:
 *   the record was lost (a memory store across a restart), and the work may or
 *   may not have happened.
 *
 * `settled` is the messages that changed, for the caller to write back, so
 * the store converges and a job settled long ago costs nothing on later loads.
 *
 * `orphans` are jobs whose tool result never reached the thread: the run died
 * between starting the job and storing the result. They are found among the
 * thread's newest jobs, only once the run that started them is gone, and only
 * the ones not marked yet; the caller marks them (`orphaned`).
 */
export async function overlayJobs(
  messages: AgentMessage[],
  params: {
    threadId: string;
    store: AgentJobStore;
    isRunLive: (runId: string) => boolean | Promise<boolean>;
    /** The tool's output schema, to check a settled output against. */
    outputSchemaFor?: (toolName: string) => Schema<any> | undefined;
  },
): Promise<{ messages: AgentMessage[]; settled: AgentMessage[]; orphans: AgentJobRecord[] }> {
  const { store, threadId } = params;
  const recent = await store.listForThread(threadId, { limit: ORPHAN_SCAN });
  const known = new Map(recent.map((record) => [record.id, record]));

  const out = messages.slice();
  const settled: AgentMessage[] = [];
  const calls = new Set<string>();

  for (let at = 0; at < out.length; at++) {
    const message = out[at]!;
    let content: AgentMessage["content"] | null = null;
    for (let index = 0; index < message.content.length; index++) {
      const part = message.content[index]!;
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type !== "tool-result" || part.status !== "running") continue;

      const id = part.job?.id;
      let record = id ? known.get(id) : undefined;
      if (id && record === undefined) {
        record = (await store.get(id)) ?? undefined;
        if (record) known.set(id, record);
      }
      if (record?.state === "running") continue;

      content ??= message.content.slice();
      content[index] = settledResult(part, record, params.outputSchemaFor);
    }
    if (content) {
      const changed: AgentMessage = { ...message, content };
      out[at] = changed;
      settled.push(changed);
    }
  }

  const orphans: AgentJobRecord[] = [];
  for (const record of recent) {
    if (record.orphaned || calls.has(record.toolCallId)) continue;
    if (await params.isRunLive(record.runId)) continue;
    orphans.push(record);
  }

  return { messages: out, settled, orphans };
}

/** Marks orphans found by `overlayJobs`. Never throws: it is bookkeeping. */
export async function markOrphans(
  store: AgentJobStore,
  orphans: AgentJobRecord[],
  report: (error: unknown) => void,
): Promise<void> {
  for (const record of orphans) {
    try {
      await store.transition(record.id, ANY_STATE, { orphaned: true });
    } catch (error) {
      report(error);
    }
  }
}

function settledResult(
  part: Extract<ToolResultPart, { status: "running" }>,
  record: AgentJobRecord | undefined,
  outputSchemaFor: ((toolName: string) => Schema<any> | undefined) | undefined,
): ToolResultPart {
  const base = { type: "tool-result" as const, toolCallId: part.toolCallId, name: part.name };
  if (!record) {
    return {
      ...base,
      status: "error",
      job: part.job,
      error: {
        code: "tool_error",
        message: `The background job for "${String(part.name)}" can no longer be found, so its result was lost. It may have run in part or in full: check its effects before repeating it.`,
        toolCallId: part.toolCallId,
        retryable: true,
      },
    };
  }

  const job: AgentJobRef = {
    id: record.id,
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
  };
  if (record.state === "error") {
    return {
      ...base,
      status: "error",
      job,
      error: record.error ?? {
        code: "tool_error",
        message: `The background job for "${String(part.name)}" failed.`,
        toolCallId: part.toolCallId,
        retryable: true,
      },
    };
  }

  const schema = outputSchemaFor?.(String(part.name));
  if (schema) {
    const parsed = schema.safeParse(record.output);
    if (parsed.ok === false) {
      return {
        ...base,
        status: "error",
        job,
        error: {
          code: "invalid_tool_result",
          message: `The background job for "${String(part.name)}" finished with an output that does not match the tool's output schema: ${parsed.errors.join(", ")}`,
          toolCallId: part.toolCallId,
          retryable: true,
        },
      };
    }
    return { ...base, status: "ok", job, output: parsed.value };
  }
  return { ...base, status: "ok", job, output: record.output };
}
