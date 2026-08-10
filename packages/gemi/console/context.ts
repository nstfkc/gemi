import { CommandFailed } from "./Command";

/**
 * The single argument a command handler receives.
 *
 * ### Why the output helpers live here and not on `this`
 *
 * The authoring surface is a builder terminating in `.handle(fn)`, and `fn` is
 * an arrow function with no useful `this`. That turns out to be the better
 * arrangement rather than a cost to work around: the helpers are destructured on
 * the first line of the handler, so a reader sees which streams a command writes
 * to before reading any of it, and a test supplies its own writers by passing a
 * context instead of subclassing.
 *
 * ### Why there are three of them
 *
 * The load-bearing thing a framework can own here is **stream discipline, not
 * colour**. A diagnostic printed to stdout is what breaks
 * `TOTAL=$(gemi run count-users)` and what makes a CI grep match a progress line
 * instead of the answer, and that mistake is invisible until somebody pipes the
 * command somewhere.
 *
 * So: `line` is the command's answer and goes to stdout, `error` is a diagnostic
 * and goes to stderr, and `fail` ends the command. Deliberately absent are
 * `info`/`success` (`line` with a colour, and colour is the application's
 * business), `warn` (identical to `error`; two names for one stream is a coin
 * flip at every call site), and tables or progress bars — a console formatting
 * library is a project, not a feature.
 */
export interface CommandContext<
  A = Record<string, unknown>,
  O = Record<string, unknown>,
> {
  /** The positional arguments, by the names `.arg()` declared. */
  args: A;

  /** The flags, by the names `.option()` declared. */
  options: O;

  /**
   * Everything after the command name, unparsed.
   *
   * The escape hatch, for a command that wants to forward its tail to something
   * else. Present even when parsing succeeded, so a command never has to choose
   * between the declared schema and the raw truth.
   */
  argv: readonly string[];

  /** The command's answer, on stdout. */
  line(message?: string): void;

  /** A diagnostic, on stderr. Does not end the command. */
  error(message: string): void;

  /**
   * Ends the command with a message and an exit code, and no stack.
   *
   * Throws rather than returning, so it type-checks as the last statement of any
   * branch and a caller cannot forget to `return` after it.
   */
  fail(message: string, code?: number): never;
}

/** Where a context writes. Injectable so tests can capture without spawning. */
export interface CommandWriters {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export function processWriters(): CommandWriters {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  };
}

export function createContext<A, O>(params: {
  args: A;
  options: O;
  argv: readonly string[];
  writers?: CommandWriters;
}): CommandContext<A, O> {
  const writers = params.writers ?? processWriters();

  return {
    args: params.args,
    options: params.options,
    argv: params.argv,
    line: (message = "") => writers.stdout(`${message}\n`),
    error: (message: string) => writers.stderr(`${message}\n`),
    fail: (message: string, code = 1) => {
      throw new CommandFailed(message, code);
    },
  };
}
