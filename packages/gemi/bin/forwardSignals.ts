import { constants } from "node:os";

type SpawnOptions = {
  cmd: string[];
  env?: Record<string, string | undefined>;
};

// Which signal the child receives for each one this process does. `SIGHUP` is
// translated rather than forwarded: the child runs in its own session (see
// below), so closing the terminal no longer reaches it, and the server only
// drains on `SIGTERM`/`SIGINT` — a forwarded `SIGHUP` would kill it outright,
// which is the behaviour this file exists to remove.
const FORWARDED = {
  SIGTERM: "SIGTERM",
  SIGINT: "SIGINT",
  SIGHUP: "SIGTERM",
} as const;

/**
 * Spawns `cmd`, relays termination signals to it, and resolves with the exit
 * code this process should exit with once the child has.
 *
 * A platform signals the process it started and nothing below it. Without this
 * the server — a grandchild of PID 1 under `gemi start` — learned about a
 * shutdown only from the `SIGKILL` at the end of the grace period, so there was
 * nothing for it to drain in (#48).
 *
 * The child is `detached` (its own session and process group) so that each
 * signal reaches it exactly once. Without it, a Ctrl+C in a terminal is
 * delivered to the whole foreground group — the child directly *and* through
 * this relay — and the server reads the second copy as "stop waiting, exit
 * now", so a Ctrl+C would never drain.
 */
export async function spawnForwardingSignals(options: SpawnOptions): Promise<number> {
  const proc = Bun.spawn({
    cmd: options.cmd,
    env: options.env,
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });

  const handlers = Object.entries(FORWARDED).map(([received, sent]) => {
    const handler = () => {
      // The child may already be gone — it exits on its own after a drain, and
      // a signal can land between that and `exited` resolving.
      try {
        proc.kill(sent);
      } catch {}
    };
    process.on(received, handler);
    return [received, handler] as const;
  });

  try {
    await proc.exited;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }

  return exitCodeOf(proc);
}

/**
 * The child's exit code, or the shell convention `128 + n` when a signal ended
 * it — a supervisor that restarts on a non-zero exit must not read a server
 * killed by `SIGKILL` as a clean `0`, which is what `gemi start` used to report
 * by dropping the code altogether.
 */
export function exitCodeOf(proc: { exitCode: number | null; signalCode: string | null }): number {
  if (proc.exitCode !== null) return proc.exitCode;
  const signal =
    proc.signalCode && constants.signals[proc.signalCode as keyof typeof constants.signals];
  return signal ? 128 + signal : 1;
}
