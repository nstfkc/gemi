import type { AgentRun, AgentRunResult } from "../Agent";
import type { AgentStreamEvent, AgentStreamFrame, ToolShapes } from "../types";

/**
 * A hand-driven `AgentRun`, for tests of everything that consumes one.
 *
 * It lives in source rather than in a test file because both the `LiveRuns`
 * tests and the controller tests need the same fake, and a test file that
 * imports another test file gets that file's suites collected twice.
 *
 * It is deliberately a *stub satisfying the interface*, not a shrunken `Agent`:
 * the real agent is a separate slice, and a test that imported it would be
 * testing whichever half of the module was written last.
 */
export class StubAgentRun implements AgentRun<ToolShapes, unknown> {
  readonly runId: string;

  stopped = false;
  stopReason: string | undefined;
  /** Every `frames()` call ever made, so a test can assert on subscribers. */
  subscriptions = 0;

  private buffer: AgentStreamFrame[] = [];
  private nextSeq = 0;
  private done = false;
  private wake = new Set<() => void>();
  /** See the note on `Entry.version` in `LiveRuns`: same missed-wakeup window,
   *  same fix. */
  private version = 0;
  private outcome: AgentRunResult<ToolShapes, unknown> | null = null;
  private settle: ((result: AgentRunResult<ToolShapes, unknown>) => void) | null = null;
  private settled: Promise<AgentRunResult<ToolShapes, unknown>>;

  constructor(runId = "run_stub") {
    this.runId = runId;
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Pushes one event onto the run, numbering it the way a real run would. */
  emit(event: AgentStreamEvent): AgentStreamFrame {
    const frame: AgentStreamFrame = { seq: this.nextSeq++, event };
    this.buffer.push(frame);
    this.notify();
    return frame;
  }

  /** Ends the run. Everything parked on `frames()` or `result()` unblocks. */
  finish(result: Partial<AgentRunResult<ToolShapes, unknown>> = {}): void {
    this.outcome = {
      runId: this.runId,
      messages: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...result,
    };
    this.done = true;
    this.settle?.(this.outcome);
    this.notify();
  }

  frames(from = 0): AsyncIterable<AgentStreamFrame> {
    this.subscriptions++;
    return this.replay(from);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentStreamEvent, void, void> {
    for await (const frame of this.frames()) {
      yield frame.event;
    }
  }

  toResponse(params: { from?: number } = {}): Response {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Stub-Run": this.runId,
        "X-Stub-From": String(params.from ?? 0),
      },
    });
  }

  result(): Promise<AgentRunResult<ToolShapes, unknown>> {
    return this.settled;
  }

  stop(params: { reason?: string } = {}): void {
    this.stopped = true;
    this.stopReason = params.reason;
  }

  private async *replay(from: number): AsyncGenerator<AgentStreamFrame, void, void> {
    let cursor = from;
    while (true) {
      const seen = this.version;
      for (const frame of this.buffer.slice()) {
        if (frame.seq >= cursor) {
          yield frame;
          cursor = frame.seq + 1;
        }
      }
      if (this.done && cursor >= this.nextSeq) {
        return;
      }
      if (this.version === seen) {
        await new Promise<void>((resolve) => this.wake.add(resolve));
      }
    }
  }

  private notify(): void {
    this.version++;
    const waiters = Array.from(this.wake);
    this.wake.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}
