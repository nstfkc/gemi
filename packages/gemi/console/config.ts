import type { CommandClass } from "./Command";

// Config key: `command`. Consumed by `gemi run`, and by nothing at boot.
//
// Named `command` rather than `console` on purpose. An app declares its slices
// by importing them into `app/kernel/Kernel.ts`, and a file called
// `app/config/console.ts` arrives there as `import console from
// "../config/console"` — which shadows the global `console` for the rest of that
// module. Every application would inherit that, silently. `command` also matches
// the singular slice names already in use: `route`, `queue`, `schedule`, `log`.
export interface CommandConfig {
  /**
   * The `Command` classes this application can run, or nothing.
   *
   * ### The rule, exactly
   *
   * **Declared wins, and `[]` is declared.** A `commands` that is present is
   * used verbatim and no directory is read — the escape hatch for an app whose
   * commands live somewhere the walk cannot reach, and for a deploy that ships
   * no source. An empty array means an app with no commands and says so; it does
   * not mean "find some".
   *
   * **Absent or `undefined` discovers.** `undefined` counts as absent for the
   * same reason `withDefaults` treats it that way everywhere else: a key spread
   * in from an optional value is an omission, not an instruction.
   *
   * ### One way this differs from `queue` and `schedule`
   *
   * There, the cost of the list and the directory disagreeing is silence — a
   * dispatch dropped with a line on stderr nobody reads, a report that stops
   * arriving. Here it is a person typing `gemi run thing` and being told, in
   * those words, that there is no command called `thing`. The rule is kept for
   * consistency and for the source-less-deploy case, not because the stakes are
   * the same.
   */
  commands?: CommandClass[];

  /**
   * Where to look when `commands` was not declared. Relative to the project
   * root, or absolute.
   *
   * Every `.ts`/`.tsx` file underneath is imported when a command is run, so
   * this wants to be a directory of command declarations rather than a directory
   * that merely contains some.
   */
  commandsDir?: string;
}

export function defineCommandConfig(config: CommandConfig): CommandConfig {
  return config;
}

export function commandConfigDefaults(): Required<CommandConfig> {
  return {
    commands: [],
    commandsDir: "app/commands",
  };
}
