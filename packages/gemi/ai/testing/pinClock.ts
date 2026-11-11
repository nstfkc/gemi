/**
 * Runs the process's clock from `at`: `Date.now()` and `new Date()` answer
 * `at` plus the time since the call, until the returned function puts the real
 * clock back. For replaying a recording (`RecordingProvider.recordedAt`), so
 * dates relative to today ("in three days", "this week") come out as they were
 * recorded. Timers are not touched: time still passes at its real rate.
 *
 *     const restore = pinClock(replay.recordedAt);
 *     try {
 *       await runTheCase(replay);
 *     } finally {
 *       restore();
 *     }
 *
 * Process-wide, like the clock it replaces: don't run two pinned replays side
 * by side. Inside vitest, `vi.setSystemTime` does the same job.
 */
export function pinClock(at: Date | string | number): () => void {
  const RealDate = globalThis.Date;
  const offset = new RealDate(at).getTime() - RealDate.now();
  if (!Number.isFinite(offset)) throw new Error(`pinClock: ${String(at)} is not a date.`);

  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string | number | Date]));
    }

    static now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  return () => {
    if (globalThis.Date === (PinnedDate as DateConstructor)) globalThis.Date = RealDate;
  };
}
