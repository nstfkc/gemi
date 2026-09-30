import type { AgentStore } from "../AgentController";
import { applyFrame, type ChatState, initialChatState } from "../client/reducer";
import type {
  AgentMessage,
  AgentStreamFrame,
  NestedRun,
  ToolCallPart,
  ToolResultPart,
} from "../types";

/**
 * A threaded turn, written to the store while it runs (#617).
 *
 * The controller used to store a turn once, when its run ended. A process that
 * died mid-run (a restart, a crash, a deploy) left the thread without the turn
 * at all, not even the user's message, while the run's tools may already have
 * written durable changes. Neither the app nor the model could tell a turn that
 * never happened from one that was lost.
 *
 * So a turn is now written as it goes, through the store's own upsert:
 *
 * - **Finished messages** (`finish`), as the run reports them: the user's turn
 *   before the model is asked anything, each assistant message as it closes,
 *   an earlier message a turn amended. The run's own objects, so they are
 *   exactly what the end-of-run write stores.
 * - **The message in progress** (`frame`), at the points worth keeping: when it
 *   opens, when a tool call's arguments are complete, when a tool result
 *   lands, and a whole message the run injected. It is assembled from the
 *   run's frames by the client reducer (the code every client already renders
 *   a live run with) and stored with no `finishReason` and the run's id in
 *   `runId`, which is what lets a later reader see that its run is gone.
 *   Text deltas are not a checkpoint: a store write per token is not worth
 *   the text a crash would lose.
 *
 * Every write is an upsert by message id, so writing a message twice, or a
 * retried start writing the same turn again, leaves one copy. Writes go out one
 * at a time and in order, off the run's path: a slow store does not slow the
 * model, and a message's in-progress copy can never land after its finished
 * one. A write that fails is reported and the run carries on, as a hook
 * failure does; the end-of-run write stores everything again anyway.
 */
export class TurnJournal {
  private chain: Promise<void> = Promise.resolve();
  /** Ids whose finished copy has been queued. An in-progress copy of one of
   *  these is stale by definition and is never written after it. */
  private readonly done = new Set<string>();
  private closed = false;
  private state: ChatState;
  private runId: string | undefined;

  constructor(
    private readonly store: AgentStore,
    private readonly threadId: string,
    /** The history the run starts from, so a tool result that lands on an
     *  earlier turn's message checkpoints the whole message, not a stub of it. */
    history: AgentMessage[],
    private readonly report: (error: unknown) => void,
  ) {
    this.state = initialChatState({ messages: history });
  }

  /** A message the run has finished. Queued as it is, and final. */
  finish(message: AgentMessage): void {
    if (this.closed) return;
    this.done.add(message.id);
    this.write(() => [snapshot(message)]);
  }

  /** One frame of the run, in order. Writes the message it touched when the
   *  frame is a checkpoint. */
  frame(frame: AgentStreamFrame): void {
    if (this.closed) return;
    const event = frame.event;
    if (event.type === "run-start") this.runId = event.runId;
    this.state = applyFrame(this.state, frame);

    switch (event.type) {
      case "message":
        // Complete when it is made (see the event), so it is written whole. Not
        // marked done: the run reports it again once the message above it
        // closes, and that copy is the one that stays.
        this.write(() => [snapshot(event.message)]);
        return;
      case "tool-call":
        if (event.part.partial) return;
        this.checkpoint(event.messageId);
        return;
      case "message-start":
      case "tool-result":
        this.checkpoint(event.messageId);
        return;
      default:
        return;
    }
  }

  /**
   * The run is over and its transcript is about to be written whole: nothing
   * more is queued after this. `messages` are the ones that write will hold,
   * so a frame still on its way cannot put an in-progress copy of one of them
   * back.
   */
  close(messages: AgentMessage[] = []): void {
    this.closed = true;
    for (const message of messages) this.done.add(message.id);
  }

  /** Settles once every queued write has. Never rejects. */
  settled(): Promise<void> {
    return this.chain;
  }

  private checkpoint(messageId: string): void {
    if (this.done.has(messageId)) return;
    const message = this.state.messages.find((held) => held.id === messageId);
    if (!message) return;
    const runId = this.runId;
    this.write(() => {
      const copy = snapshot(message);
      // Stamped only on a message still being written: the run's id is the
      // thing a reader checks for liveness, and a finished message has nothing
      // to check.
      if (copy.finishReason === undefined && runId) copy.runId = runId;
      return [copy];
    });
  }

  /**
   * Queues one write. The copy is taken now, before anything else can change
   * the message, and a copy that fails (a tool output that is not plain data)
   * costs that one write, not the journal: the end-of-run write still stores
   * the message.
   */
  private write(copy: () => AgentMessage[]): void {
    let messages: AgentMessage[];
    try {
      messages = copy();
    } catch (error) {
      this.report(error);
      return;
    }
    this.chain = this.chain
      .then(() => this.store.appendMessages(this.threadId, messages))
      .catch((error) => this.report(error));
  }
}

/**
 * A copy the run cannot change under the store. The run keeps writing to its
 * own objects (a tool result onto the message that made the call), and a store
 * that holds references, as `MemoryAgentStore` does, would otherwise show a
 * reader a message that changes after it was written.
 */
function snapshot(message: AgentMessage): AgentMessage {
  return structuredClone(message);
}

/**
 * The thread as it stands, with every message a dead run left unfinished
 * marked as such.
 *
 * An assistant message with no `finishReason` is either still being written or
 * was being written by a run that is gone. `isLive` tells the two apart by the
 * message's `runId`; a message without one belongs to no run and is gone too.
 * Each gone one is closed as `interrupted`:
 *
 * - its own `finishReason`, so a UI shows "cut off" rather than a cursor that
 *   never stops;
 * - a `denied` result with `cause: "interrupted"` for every tool call it left
 *   without one, so the history stays valid for the provider (a call with no
 *   output is a 400) and the model reads what happened to it;
 * - the same reason on any sub-run under its tool calls that never finished,
 *   which would otherwise draw a cursor of its own.
 *
 * `settled` is the messages that changed, for the caller to write back. Running
 * this again on its own output changes nothing, which is what makes it safe to
 * run on every read.
 */
export async function settleInterrupted(
  messages: AgentMessage[],
  isLive: (runId: string) => boolean | Promise<boolean>,
): Promise<{ messages: AgentMessage[]; settled: AgentMessage[] }> {
  const settled: AgentMessage[] = [];
  let resolved: Set<string> | null = null;
  const out = messages.slice();

  for (let at = 0; at < out.length; at++) {
    const message = out[at]!;
    if (message.role !== "assistant" || message.finishReason !== undefined) continue;
    if (message.runId && (await isLive(message.runId))) continue;

    // Computed once, and only for a thread that has something to settle,
    // which is almost never.
    resolved ??= new Set(
      messages.flatMap((held) =>
        held.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : [])),
      ),
    );

    const content = message.content.map((part) =>
      part.type === "tool-call" ? closeCall(part as ToolCallPart) : part,
    );
    for (const part of message.content) {
      if (part.type !== "tool-call" || resolved.has(part.toolCallId)) continue;
      const result: ToolResultPart = {
        type: "tool-result",
        toolCallId: part.toolCallId,
        name: part.name,
        status: "denied",
        cause: "interrupted",
      };
      content.push(result);
    }
    const closed: AgentMessage = { ...message, content, finishReason: "interrupted" };
    out[at] = closed;
    settled.push(closed);
  }

  return { messages: out, settled };
}

/** A call as a dead run left it: its arguments are all there will ever be,
 *  and a sub-run under it that never finished is interrupted too. */
function closeCall(part: ToolCallPart): ToolCallPart {
  const { partial: _partial, ...call } = part;
  if (!call.nested?.some((run) => run.finishReason === undefined)) return call as ToolCallPart;
  return { ...call, nested: call.nested.map(closeRun) } as ToolCallPart;
}

function closeRun(run: NestedRun): NestedRun {
  if (run.finishReason !== undefined) return run;
  return {
    ...run,
    finishReason: "interrupted",
    messages: run.messages.map((message) =>
      message.role === "assistant" && message.finishReason === undefined
        ? {
            ...message,
            finishReason: "interrupted" as const,
            content: message.content.map((part) =>
              part.type === "tool-call" ? closeCall(part as ToolCallPart) : part,
            ),
          }
        : message,
    ),
  };
}
