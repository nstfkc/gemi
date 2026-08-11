/**
 * The failures `gemi run` prints as sentences rather than stack traces.
 *
 * Its own file rather than a declaration in `runner.ts`, because the classes
 * that *raise* these are the ones the runner imports — `CommandRegistry` most of
 * all — and a registry importing the runner to reach its error type is a cycle
 * for no reason.
 *
 * The split this exists to serve is the one `bin/gemi.ts` already draws around
 * `CheckModelsError`: a message written for the operator standing at the
 * terminal, with the fix named in it, is printed alone; anything else is a bug
 * in the framework and keeps its stack so it can be reported.
 */
export class ConsoleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConsoleError";
  }
}
