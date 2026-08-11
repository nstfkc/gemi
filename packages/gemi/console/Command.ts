/**
 * A command an operator runs by hand: `gemi run backfill-avatars --dry-run`.
 *
 * This file is the *runtime* shape — the base class discovery walks the
 * prototype chain for, and the statics the runner reads. It is not the
 * authoring surface. Applications write commands with `defineCommand` in
 * `./builder`, which produces one of these; see that file for why the authoring
 * surface is a builder and not a class body.
 *
 * ### Why the schema is descriptors and not a signature string
 *
 * Laravel spells this `protected $signature = 'mail:send {user} {--queue}'`, and
 * the string is the whole schema. It reads beautifully and TypeScript cannot see
 * a word of it: a brace in the wrong place is a parse error the first time
 * somebody runs the command, months after it was written, and the parser is a
 * piece of framework surface with its own failure modes. The descriptors below
 * say the same thing in a shape the compiler checks — and, through the builder,
 * in a shape that types the handler's own body.
 *
 * ### Why the name is declared and never falls back to the class name
 *
 * `Job` keys off `static name`, which shadows `Function.name`. That is the right
 * trade there: a job's name *is* its class name, and the shadow is what makes it
 * a string literal that survives minification. Here it is the wrong one twice
 * over. A command's name is a CLI token (`backfill-avatars`, `db:seed`) with no
 * relationship to the class name, so an implicit fallback would only ever be
 * wrong; and shadowing `Function.name` costs the one error anybody will actually
 * hit — "two commands claim `db:seed`" — the ability to say *which two*.
 *
 * ### The minification hazard does not reach here
 *
 * `services/discovery.ts` warns about a job that never declared `static name`,
 * because two halves have to agree on one string across a bundler: the
 * dispatcher, minified into `dist/server/server.mjs`, and discovery, reading the
 * source. A command has one half — a human types the name and it is matched
 * against discovery-on-source. Nothing in the server bundle names a command, and
 * `gemi build` keeps `app/commands` out of the bundle anyway. So there is no
 * `warnIfNameWillNotSurviveTheBuild` equivalent below, and adding one by analogy
 * would be noise.
 *
 * If a `Command.call("db:seed")` reachable from a controller is ever added, that
 * changes — and `commandName` being a declared string literal already covers it,
 * which is one more reason not to fall back to the class binding.
 */

/** A positional argument. `variadic` collects the rest and must come last. */
export interface ArgSpec {
  description?: string;
  /**
   * Missing it is a usage error rather than an `undefined` in the handler.
   * Mutually exclusive with `default` — an argument that is supplied when absent
   * cannot also be absent, and declaring both is refused rather than silently
   * resolved in one direction.
   */
  required?: boolean;
  /** Collects every remaining positional. Only legal on the last argument. */
  variadic?: boolean;
  /** Supplied when the argument is absent, which makes it always present. */
  default?: string;
}

/**
 * A flag. The `type` decides both how the value is parsed and what the handler
 * sees, which is why it is required rather than defaulted to `string`: a
 * `--dry-run` declared without a type would arrive as the string `""`, and every
 * `if (options.dryRun)` over it would be wrong in the one direction nobody
 * tests.
 */
export type OptionSpec =
  | {
      type: "boolean";
      description?: string;
      /** Single character, without the dash. */
      alias?: string;
      default?: boolean;
    }
  | {
      type: "string";
      description?: string;
      alias?: string;
      default?: string;
      required?: boolean;
    }
  | {
      type: "number";
      description?: string;
      alias?: string;
      default?: number;
      required?: boolean;
    };

/** An argument as stored on the class: the spec, plus the name it was given. */
export type CommandArgument = ArgSpec & { name: string };

/** An option as stored on the class: the spec, plus the name it was given. */
export type CommandOption = OptionSpec & { name: string };

/** What a handler may return. `void` and `0` mean the same thing. */
export type CommandResult = Promise<number | void> | number | void;

/**
 * A command that failed on purpose.
 *
 * The distinction `bin/check-models.ts` draws between `CheckModelsError` and
 * everything else, in the one place an application can reach it: this is a
 * sentence written for the terminal and is printed without a stack, while
 * anything else that escapes a handler is a bug and keeps its stack.
 */
export class CommandFailed extends Error {
  constructor(
    message: string,
    readonly code: number = 1,
  ) {
    super(message);
    this.name = "CommandFailed";
  }
}

/**
 * The base class. Discovery finds subclasses of this; the runner reads the
 * statics and calls `run`.
 *
 * Subclassing it by hand works and is what `defineCommand` does under the hood,
 * but it gives up the typing that is the whole point of the builder — `run`'s
 * parameter cannot be inferred from statics declared on the subclass, because
 * TypeScript does not contextually type an overriding method's parameters. Write
 * commands with `defineCommand`.
 */
export class Command {
  /**
   * The name typed on the command line. Mandatory: there is no sensible default
   * and the class name is not one.
   */
  static commandName = "unset";

  /** One line, printed by `gemi run` with no name and at the top of `--help`. */
  static description = "";

  /** Positional arguments, in order. A variadic one must be last. */
  static args: CommandArgument[] = [];

  /** Flags. Declared in camelCase; `dryRun` is spelled `--dry-run` on the CLI. */
  static options: CommandOption[] = [];

  /**
   * The body.
   *
   * Runs inside `kernel.run()`, so `app(MailManager)` and a model read resolve
   * exactly as they do in a request handler. Resolve services *here* rather than
   * at module load: a command file is imported by discovery before the container
   * has finished booting, and a service captured at the top of the file is
   * captured from a container that is not ready.
   */
  run(_ctx: any): CommandResult {}
}

/** The type of a class `defineCommand(...).handle(...)` produces. */
export type CommandClass = typeof Command;
