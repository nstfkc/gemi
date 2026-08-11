import type { CommandClass } from "./Command";
import { ConsoleError } from "./errors";

/**
 * The commands an application has, and the rules about what a command may be.
 *
 * A plain class, not a container service, and that is a decision rather than an
 * omission. `QueueManager` and `Scheduler` are bound and populated during boot
 * because the server needs them: a dispatch or a tick can arrive at any moment
 * after boot finishes. A command registry has exactly one consumer — `gemi run`,
 * which builds one, uses it, and exits. Making it a boot step would import every
 * file under `app/commands` into every `gemi dev`, every `gemi start` and every
 * deployed server process, on every start, for code no request will ever reach.
 * That is the cost `bin/check-models.ts` argues against at length, and there is
 * no benefit here to weigh against it.
 *
 * What the class is for is the rules below, and the `commands` getter — the same
 * seam `QueueManager.registeredJobs` and `Scheduler.jobs` exist to give a test:
 * what was actually taken, rather than what a walk would find if asked again.
 */
export class CommandRegistry {
  private readonly byName = new Map<string, CommandClass>();

  /**
   * @throws ConsoleError naming the offending class for a command that cannot
   * be run.
   *
   * Every refusal here is loud and immediate. There is a human at a terminal,
   * and every one of these is a mistake in the application's own source that
   * they are better off seeing now than after the command they meant to run
   * silently did not exist.
   *
   * `ConsoleError` rather than a plain `Error` so the runner prints the message
   * alone. These are sentences with the fix named in them, and burying one under
   * `at new CommandRegistry (…)` plus the runner's own frames points the reader
   * at framework code when the mistake is in their `app/commands`.
   */
  constructor(commands: CommandClass[]) {
    for (const command of commands) {
      const name = command.commandName;

      if (!name || name === "unset") {
        throw new ConsoleError(
          `${describe(command)} does not declare a command name, so there is ` +
            `no name to run it by. Commands are written with \`defineCommand\`:` +
            `\n\n    export default defineCommand("my-command")\n` +
            `      .handle(async ({ line }) => { line("hello") })`,
        );
      }

      const existing = this.byName.get(name);
      if (existing) {
        // Deliberately a hard error, where `QueueManager.useJobs` and
        // `Scheduler.start` take the first and warn. Those two must keep a
        // server booting, so running one of two identically-named jobs beats
        // refusing to start at all. Here there is no boot to protect and a
        // person is waiting: running the wrong one of two commands called
        // `db:seed` is strictly worse than running neither and being told why.
        throw new ConsoleError(
          `Two commands are named "${name}": ${describe(existing)} and ` +
            `${describe(command)}. A command name is how it is run, so one of ` +
            `them could never be reached — rename one.`,
        );
      }

      this.byName.set(name, command);
    }
  }

  /** What was actually taken. */
  get commands(): CommandClass[] {
    return [...this.byName.values()];
  }

  get(name: string): CommandClass | undefined {
    return this.byName.get(name);
  }

  /**
   * The nearest names to something that did not match, for the "did you mean"
   * line. Prefix matches first, then substring, then names sharing a namespace —
   * `db:sed` should find `db:seed`, and a typo in a namespace is the common case.
   */
  suggest(name: string): string[] {
    const needle = name.toLowerCase();
    const namespace = needle.includes(":") ? needle.split(":")[0] : undefined;
    const scored: Array<[number, string]> = [];

    for (const candidate of this.byName.keys()) {
      const haystack = candidate.toLowerCase();
      if (haystack.startsWith(needle) || needle.startsWith(haystack)) {
        scored.push([0, candidate]);
      } else if (haystack.includes(needle) || needle.includes(haystack)) {
        scored.push([1, candidate]);
      } else if (namespace && haystack.startsWith(`${namespace}:`)) {
        scored.push([2, candidate]);
      } else if (editDistance(haystack, needle) <= 2) {
        scored.push([3, candidate]);
      }
    }

    return scored
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
      .slice(0, 3)
      .map(([, candidate]) => candidate);
  }
}

function describe(command: CommandClass): string {
  return command.name ? `\`${command.name}\`` : "an anonymous command class";
}

/** Small enough that a dependency would cost more than it saves. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length]!;
}
