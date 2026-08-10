import path from "node:path";

import type { Kernel } from "../kernel/Kernel";
import { discoverCommands } from "../services/discovery";
import { DiscoveryError } from "../support/discover";
import { withDefaults } from "../support/withDefaults";
import { CommandFailed, type CommandClass } from "./Command";
import { CommandRegistry } from "./CommandRegistry";
import { commandConfigDefaults, type CommandConfig } from "./config";
import { createContext, processWriters, type CommandWriters } from "./context";
import { parseArgv, wantsHelp } from "./parse";
import { renderList, renderUsage } from "./usage";

/**
 * `gemi run`, from the inside.
 *
 * This runs in a Bun process the CLI spawned, not in the CLI. That is the whole
 * reason the file exists, and it is worth stating here because everything below
 * assumes it:
 *
 *   - `dist/bin/gemi.js` bundles its own copy of gemi, while the application's
 *     Kernel resolves `gemi/*` to source. Discovery decides membership by
 *     walking the prototype chain, so a `Command` base imported into the CLI
 *     bundle is a *different class object* from the one `app/commands/*.ts`
 *     extends — every command would be invisible, silently. In this process
 *     there is one copy and the question does not arise.
 *   - `--preload gemi/bun/preload` and the app's own `app/preload.ts` can only
 *     be registered at process start, and a command that touches a controller
 *     needs the first while the template's models need the second.
 *   - Bun fixes its JSX transform and react-dom's export conditions from
 *     `NODE_ENV` at startup, so a command that renders an email is only correct
 *     in a process that began with the right one.
 *
 * ### Why the ordering below is the ordering
 *
 * Listing commands, reporting an unknown name and printing `--help` all resolve
 * *before* `waitForBoot()`. Those are the three things an operator does most
 * often and the three that need nothing from the application beyond its config,
 * so none of them should open a database connection. Running a command needs the
 * full boot and takes it.
 */

/** A failure with a sentence written for the terminal. Never printed with a stack. */
export class ConsoleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConsoleError";
  }
}

export interface RunConsoleParams {
  rootDir: string;
  /** The command to run. Absent means "list what there is". */
  name?: string;
  /** Everything after the name, already stripped of a leading `--`. */
  argv: readonly string[];
  writers?: CommandWriters;
}

export async function runConsole(params: RunConsoleParams): Promise<number> {
  const writers = params.writers ?? processWriters();
  const out = (message: string) => writers.stdout(`${message}\n`);
  const err = (message: string) => writers.stderr(`${message}\n`);

  let kernel: Kernel | undefined;

  try {
    kernel = await loadKernel(params.rootDir);
    kernel.boot();

    const slice = kernel.app.config.get<CommandConfig>("command", {});
    const dir = withDefaults(commandConfigDefaults(), slice).commandsDir;

    // Resolved against `rootDir` rather than left for `discoverCommands` to hang
    // off `projectRoot()`. In the spawned process the two are the same thing —
    // the CLI spawns with no `cwd`, so the child inherits the project root — but
    // "the same thing in production" is how a parameter quietly stops being one.
    // This function already resolves the Kernel against `rootDir`, and a caller
    // that passes a directory only for half of it to be honoured is the kind of
    // thing tests find and nothing else does.
    const commandsDir = path.isAbsolute(dir)
      ? dir
      : path.join(params.rootDir, dir);

    // Declared wins, and `[]` is declared. Read before `withDefaults`, which
    // collapses absent and `undefined` into the default `[]` — the same value an
    // app writes when it means "none, and I mean it".
    const declared = slice.commands !== undefined;
    const commands = declared
      ? slice.commands!
      : await discoverCommands(commandsDir);

    const registry = new CommandRegistry(commands);
    const source = { declared, dir };

    if (params.name === undefined) {
      out(renderList(registry.commands, source));
      return 0;
    }

    const command = registry.get(params.name);

    if (!command) {
      const suggestions = registry.suggest(params.name);
      err(
        `No command named \`${params.name}\`.` +
          (suggestions.length > 0
            ? ` Did you mean ${suggestions
                .map((candidate) => `\`${candidate}\``)
                .join(", or ")}?`
            : ""),
      );
      err("");
      err(renderList(registry.commands, source));
      return 1;
    }

    const spec = {
      commandName: command.commandName,
      args: command.args,
      options: command.options,
    };

    if (wantsHelp(spec, params.argv)) {
      out(renderUsage(command));
      return 0;
    }

    const parsed = parseArgv(spec, params.argv);

    // `=== false` rather than `!parsed.ok`: the package compiles with
    // `strictNullChecks` off, and under it a `!x.ok` test does not narrow a
    // discriminated union while an explicit comparison does. The negation
    // compiles to the same check and reads the same, which is exactly why it is
    // worth a line — it fails as a type error here, but the same shape in an
    // untypechecked file would just quietly be `any`.
    if (parsed.ok === false) {
      for (const message of parsed.errors) err(message);
      err("");
      err(renderUsage(command));
      return 1;
    }

    // Only now. Everything above answered a question about the application's
    // shape; this is the first line that needs the application itself.
    await kernel.waitForBoot();

    const context = createContext({
      args: parsed.args,
      options: parsed.options,
      argv: params.argv,
      writers,
    });

    const result = await kernel.run(() =>
      Promise.resolve(
        new (command as new () => { run(ctx: unknown): unknown })().run(
          context,
        ),
      ),
    );

    return exitCodeFor(result, command, err);
  } catch (error) {
    // A `CommandFailed`, a `ConsoleError` or a `DiscoveryError` is a sentence
    // written for this moment; anything else is a bug and keeps its stack. The
    // same split `bin/gemi.ts` already applies to `CheckModelsError`.
    //
    // `DiscoveryError` belongs in this list rather than the other because every
    // way of raising one — a command file that will not import, a builder chain
    // that was never finished — is a mistake in the application's own source
    // with the fix named in the message. A stack above it points at this
    // runner's frames, which is not where anybody needs to look.
    if (error instanceof CommandFailed) {
      err(error.message);
      return error.code;
    }

    if (error instanceof ConsoleError || error instanceof DiscoveryError) {
      err(error.message);
      return 1;
    }

    err(String((error as Error)?.stack ?? error));
    return 1;
  } finally {
    // Stops the Scheduler if it was resolved, flushes the container, clears the
    // static instance and disables the kernel context. The caller still exits
    // explicitly — see `run.ts`.
    kernel?.destroy();
  }
}

async function loadKernel(rootDir: string): Promise<Kernel> {
  const kernelPath = path.resolve(rootDir, "app/kernel/Kernel.ts");

  let module: { default?: new () => Kernel };
  try {
    module = await import(kernelPath);
  } catch (error) {
    throw new ConsoleError(
      `Could not load ${kernelPath}:\n    ${(error as Error).message}\n` +
        `\`gemi run\` boots your application the way the server does, so it ` +
        `needs the Kernel. Run it from the root of a gemi project.`,
      { cause: error },
    );
  }

  if (typeof module.default !== "function") {
    throw new ConsoleError(
      `${kernelPath} has no default export. gemi expects the Kernel subclass ` +
        `to be the default export of that file.`,
    );
  }

  return new module.default();
}

/**
 * What the handler returned, as something a shell can branch on.
 *
 * A returned value that is not an exit code is reported rather than coerced:
 * `return users.length` is an easy thing to write and would otherwise turn 300
 * backfilled users into exit status 44 (300 & 255), which reads as a failure to
 * everything downstream.
 */
function exitCodeFor(
  result: unknown,
  command: CommandClass,
  err: (message: string) => void,
): number {
  if (result === undefined || result === null) return 0;

  if (
    typeof result === "number" &&
    Number.isInteger(result) &&
    result >= 0 &&
    result <= 255
  ) {
    return result;
  }

  err(
    `Command "${command.commandName}" returned ${JSON.stringify(result)}, ` +
      `which is not an exit code. Return nothing for success, or an integer ` +
      `from 0 to 255. Treating this as a failure.`,
  );
  return 1;
}
