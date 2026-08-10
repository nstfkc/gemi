import {
  Command,
  type ArgSpec,
  type CommandArgument,
  type CommandClass,
  type CommandOption,
  type CommandResult,
  type OptionSpec,
} from "./Command";
import type { CommandContext } from "./context";

/**
 * Declaring a command, in the one shape that can type its own body.
 *
 * ### Why a builder and not a class
 *
 * The point of declaring arguments and options at all is that the handler then
 * knows what it has. A class body cannot deliver that, and the reason is a hard
 * TypeScript rule rather than a matter of arrangement: **TypeScript does not
 * contextually type a method's parameters from the base-class method it
 * overrides.** So both class-shaped designs fail in the same place:
 *
 * ```ts
 * class Backfill extends Command {
 *   static args = [{ name: "since", required: true }];
 *   async run(ctx) {}                       // implicit any
 * }
 *
 * class Backfill extends Command.define({ since: { required: true } }) {
 *   async run(ctx) {}                       // still implicit any — the
 * }                                         // configured base's signature does
 *                                           // not flow into the override
 * ```
 *
 * The author's only way out is to restate the type by hand, which is the
 * ceremony the descriptors existed to remove — and which nothing enforces, so a
 * wrong restatement compiles.
 *
 * A **function expression passed as an argument is contextually typed**. That is
 * the entire mechanism here, and it is why this is a builder rather than sugar:
 * `.handle(fn)` carries the accumulated argument and option types into `fn`'s
 * parameter with nothing written by hand and nothing to keep in step.
 *
 * ### What it produces
 *
 * A `Command` subclass, so nothing downstream knows the difference: discovery
 * finds it by prototype chain, and the registry, parser and `--help` read the
 * same statics they would read off a hand-written class. The builder is an
 * authoring surface over one runtime shape, not a second mechanism.
 */

/**
 * Marks a builder that was never finished. `discoverCommands` looks for this on
 * the exports it is about to discard — see the note on `handle` below.
 */
export const BUILDER_BRAND: unique symbol = Symbol.for("gemi.console.builder");

/** Flattens an accumulated intersection so editor hovers stay readable. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * What the handler sees for one argument.
 *
 * The order matters: `variadic` first because it wins over everything, then the
 * two ways an argument is guaranteed present. Anything else can be absent and
 * says so.
 */
export type ArgValue<S> = S extends { variadic: true }
  ? string[]
  : S extends { required: true }
    ? string
    : S extends { default: string }
      ? string
      : string | undefined;

/** What the handler sees for one option. */
export type OptionValue<S> = S extends { type: "boolean" }
  ? boolean
  : S extends { type: "number" }
    ? S extends { default: number }
      ? number
      : S extends { required: true }
        ? number
        : number | undefined
    : S extends { default: string }
      ? string
      : S extends { required: true }
        ? string
        : string | undefined;

export interface CommandBuilder<
  A extends Record<string, unknown>,
  O extends Record<string, unknown>,
> {
  /** One line, shown in the listing and at the top of `--help`. */
  describe(text: string): CommandBuilder<A, O>;

  /**
   * A positional argument. Declared in the order it is read from the command
   * line; a `variadic` one must be last.
   */
  arg<N extends string, const S extends ArgSpec = {}>(
    name: N,
    spec?: S,
  ): CommandBuilder<A & { [K in N]: ArgValue<S> }, O>;

  /**
   * A flag. Declared in camelCase and spelled in kebab-case on the command line,
   * so `.option("dryRun", …)` is `--dry-run` for the operator and
   * `options.dryRun` in the handler — no string key nobody can autocomplete, and
   * no CLI flag with a capital letter in it.
   */
  option<N extends string, const S extends OptionSpec>(
    name: N,
    spec: S,
  ): CommandBuilder<A, O & { [K in N]: OptionValue<S> }>;

  /**
   * The body, and the terminal of the chain.
   *
   * A builder that never reaches here is not a class, so discovery would skip it
   * and the command would simply vanish from `gemi run` with nothing raised —
   * the silence #322 and #323 exist to remove, reintroduced by a new authoring
   * surface. `discoverCommands` therefore looks for `BUILDER_BRAND` among the
   * exports it discards and refuses the file by name.
   */
  handle(
    fn: (ctx: CommandContext<Simplify<A>, Simplify<O>>) => CommandResult,
  ): CommandClass;
}

/**
 * Refused early, where the author is looking.
 *
 * The whitespace and brace checks are aimed at one specific reader: somebody who
 * knows Laravel and reaches for `defineCommand("mail:send {user} {--queue}")`.
 * Without this they get a command registered under a name containing a space,
 * which can never be typed and never runs, and no explanation.
 */
function assertUsableName(name: string): void {
  if (name.trim() === "") {
    throw new Error("A command name cannot be empty.");
  }

  if (/[{}]/.test(name) || /\s/.test(name)) {
    throw new Error(
      `Invalid command name ${JSON.stringify(name)}. gemi does not parse a ` +
        `signature string; the name is the whole of it. Declare arguments ` +
        `with .arg() and flags with .option():\n\n` +
        `    defineCommand("mail:send")\n` +
        `      .arg("user", { required: true })\n` +
        `      .option("queue", { type: "boolean" })\n` +
        `      .handle(async ({ args, options }) => { ... })`,
    );
  }
}

export function defineCommand(name: string): CommandBuilder<{}, {}> {
  assertUsableName(name);

  const args: CommandArgument[] = [];
  const options: CommandOption[] = [];
  let description = "";

  const builder = {
    [BUILDER_BRAND]: name,

    describe(text: string) {
      description = text;
      return builder;
    },

    arg(argName: string, spec: ArgSpec = {}) {
      // Checked here rather than at parse time because both of these are
      // mistakes in the declaration, and the declaration is what the author is
      // looking at right now. At parse time they would surface as a confusing
      // usage error in front of an operator who cannot fix them.
      if (spec.required && spec.default !== undefined) {
        throw new Error(
          `Argument "${argName}" of command "${name}" is both required and has ` +
            `a default. An argument that is supplied when absent cannot also be ` +
            `absent — drop one.`,
        );
      }

      const variadic = args.find((existing) => existing.variadic);
      if (variadic) {
        throw new Error(
          `Argument "${argName}" of command "${name}" is declared after the ` +
            `variadic argument "${variadic.name}", which collects everything ` +
            `that follows, so "${argName}" could never receive a value. A ` +
            `variadic argument must be declared last.`,
        );
      }

      if (args.some((existing) => existing.name === argName)) {
        throw new Error(
          `Command "${name}" declares the argument "${argName}" twice.`,
        );
      }

      args.push({ ...spec, name: argName });
      return builder;
    },

    option(optionName: string, spec: OptionSpec) {
      if (options.some((existing) => existing.name === optionName)) {
        throw new Error(
          `Command "${name}" declares the option "${optionName}" twice.`,
        );
      }

      const alias = "alias" in spec ? spec.alias : undefined;
      const clash =
        alias === undefined
          ? undefined
          : options.find(
              (existing) => "alias" in existing && existing.alias === alias,
            );
      if (clash) {
        throw new Error(
          `Options "${clash.name}" and "${optionName}" of command "${name}" ` +
            `both use the alias "-${alias}".`,
        );
      }

      options.push({ ...spec, name: optionName });
      return builder;
    },

    handle(fn: (ctx: any) => CommandResult) {
      const commandName = name;
      const commandDescription = description;

      const cls = class extends Command {
        static commandName = commandName;
        static description = commandDescription;
        static args = args;
        static options = options;

        run(ctx: any) {
          return fn(ctx);
        }
      };

      // An anonymous class expression reports `name === ""`, and the duplicate-
      // name error's whole job is to say *which two*. Give it the one name it
      // has.
      Object.defineProperty(cls, "name", {
        value: commandName,
        configurable: true,
      });

      return cls;
    },
  };

  return builder as unknown as CommandBuilder<{}, {}>;
}

/** True for a builder that never called `.handle()`. */
export function isUnfinishedBuilder(
  value: unknown,
): value is { [BUILDER_BRAND]: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<PropertyKey, unknown>)[BUILDER_BRAND] === "string"
  );
}
