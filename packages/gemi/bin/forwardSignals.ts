import { constants } from "node:os";

type SpawnOptions = {
  cmd: string[];
  env?: Record<string, string | undefined>;
};

// Only the two the server drains on. `SIGHUP` is left alone: a closed terminal
// sends it to the whole foreground group, the server included, which ends as
// it did before this relay existed — and under `nohup` both keep ignoring it,
// which a listener here would override.
const FORWARDED = ["SIGTERM", "SIGINT"] as const;

/**
 * Spawns `cmd`, relays termination signals to it, and resolves with the exit
 * code this process should exit with once the child has.
 *
 * A platform signals the process it started and nothing below it. Without this
 * the server — a grandchild of PID 1 under `gemi start` — learned about a
 * shutdown only from the `SIGKILL` at the end of the grace period, so there was
 * nothing for it to drain in (#48).
 *
 * The child stays in this process's group, so whatever signals the group — a
 * terminal's Ctrl+C, a supervisor's group `SIGKILL` — still reaches it
 * directly. A signal sent that way arrives twice, directly and through this
 * relay; the server reads a repeat within a second of the first as the same
 * shutdown (see `installShutdownSignals`), so it still drains once. Spawning it
 * `detached` would avoid the duplicate only from this layer — not from
 * `bun run` or systemd above it — and would orphan the server, port and all,
 * whenever `gemi start` is killed without a chance to relay.
 */
export async function spawnForwardingSignals(options: SpawnOptions): Promise<number> {
  const proc = Bun.spawn({
    cmd: options.cmd,
    env: options.env,
    stdout: "inherit",
    stderr: "inherit",
  });

  const handlers = FORWARDED.map((signal) => {
    const handler = () => {
      // The child may already be gone — it exits on its own after a drain, and
      // a signal can land between that and `exited` resolving.
      try {
        proc.kill(signal);
      } catch {}
    };
    process.on(signal, handler);
    return [signal, handler] as const;
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
