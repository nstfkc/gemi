import type { CommandArgument, CommandOption } from "./Command";

/**
 * Turning what an operator typed into what a handler declared it wanted.
 *
 * A pure function over `(spec, argv)`, deliberately: this is where every
 * off-by-one in argument handling lives, and a pure function is one a test can
 * exercise a hundred ways without a project on disk, a spawned process or a
 * booted container. `runner.ts` does the parts that need those.
 *
 * ### Why gemi parses this itself instead of handing it to commander
 *
 * commander is a dependency of this package and would resolve here, and an
 * earlier draft used it. Two things argued it back out. The schema is already
 * declared — named options with a `type`, not commander's `"-t, --tries <n>"`
 * flag strings — so using commander means translating one declaration into
 * another and then translating its output back, with the type information lost
 * in the middle. And commander is currently a *CLI-side* concern: `bin/gemi.ts`
 * uses it, and nothing that runs inside an application does. Keeping it that way
 * means a command's parsing has no dependency at all, which matters more here
 * than it looks — this code runs in the application's process, next to the
 * application's own module graph.
 *
 * `usage.ts` renders `--help` from the same spec this reads, so the help and the
 * parser cannot drift.
 */

/** `dryRun` -> `dry-run`. What the operator types. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export interface CommandSpec {
  commandName: string;
  args: CommandArgument[];
  options: CommandOption[];
}

export type ParseResult =
  | {
      ok: true;
      args: Record<string, string | string[] | undefined>;
      options: Record<string, string | number | boolean | undefined>;
    }
  | { ok: false; errors: string[] };

function optionIndex(options: CommandOption[]) {
  const byName = new Map<string, CommandOption>();
  const byAlias = new Map<string, CommandOption>();

  for (const option of options) {
    // Both spellings resolve, so `--dryRun` works for anyone who typed the
    // declared name out of habit. The kebab form is the documented one.
    byName.set(kebab(option.name), option);
    byName.set(option.name, option);
    const alias = "alias" in option ? option.alias : undefined;
    if (alias) byAlias.set(alias, option);
  }

  return { byName, byAlias };
}

/**
 * Whether this invocation is asking for help rather than running.
 *
 * A command that declares its own `help` option or `-h` alias keeps them — the
 * application's schema wins over the framework's convenience, because the
 * alternative is a flag that silently does something other than what the command
 * documents.
 */
export function wantsHelp(spec: CommandSpec, argv: readonly string[]): boolean {
  const { byName, byAlias } = optionIndex(spec.options);
  if (byName.has("help") || byAlias.has("h")) return false;

  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
  }

  return false;
}

export function parseArgv(
  spec: CommandSpec,
  argv: readonly string[],
): ParseResult {
  const { byName, byAlias } = optionIndex(spec.options);
  const errors: string[] = [];
  const positionals: string[] = [];
  const raw = new Map<string, string | boolean>();

  const unknown = (token: string) =>
    errors.push(`Unknown option ${token} for command "${spec.commandName}".`);

  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;

    // Everything after a bare `--` is positional, however it is spelled. This is
    // the escape hatch for an argument that looks like a flag.
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      const key = equals === -1 ? body : body.slice(0, equals);
      const inline = equals === -1 ? undefined : body.slice(equals + 1);

      let option = byName.get(key);
      let negated = false;

      // `--no-dry-run` only when there is no option actually called that.
      if (!option && key.startsWith("no-")) {
        const positive = byName.get(key.slice(3));
        if (positive && positive.type === "boolean") {
          option = positive;
          negated = true;
        }
      }

      if (!option) {
        unknown(`--${key}`);
        index += 1;
        continue;
      }

      if (option.type === "boolean") {
        if (inline !== undefined && inline !== "true" && inline !== "false") {
          errors.push(
            `Option --${kebab(option.name)} is a flag and takes no value, ` +
              `but got ${JSON.stringify(inline)}.`,
          );
        } else {
          const value = inline === undefined ? true : inline === "true";
          raw.set(option.name, negated ? !value : value);
        }
        index += 1;
        continue;
      }

      const value = inline ?? argv[index + 1];
      if (value === undefined) {
        errors.push(`Option --${kebab(option.name)} needs a value.`);
        index += 1;
        continue;
      }

      raw.set(option.name, value);
      index += inline === undefined ? 2 : 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      // A cluster: every character is an alias. All but the last must be flags,
      // and the last may take the remainder of the token as its value (`-l50`,
      // `-l=50`) or the next argument.
      const chars = token.slice(1);
      let consumedNext = false;

      for (let position = 0; position < chars.length; position += 1) {
        const option = byAlias.get(chars[position]!);
        if (!option) {
          unknown(`-${chars[position]}`);
          break;
        }

        if (option.type === "boolean") {
          raw.set(option.name, true);
          continue;
        }

        const rest = chars.slice(position + 1);
        const inline = rest.startsWith("=") ? rest.slice(1) : rest;
        if (inline !== "") {
          raw.set(option.name, inline);
        } else if (argv[index + 1] !== undefined) {
          raw.set(option.name, argv[index + 1]!);
          consumedNext = true;
        } else {
          errors.push(`Option -${option.alias} needs a value.`);
        }
        break;
      }

      index += consumedNext ? 2 : 1;
      continue;
    }

    positionals.push(token);
    index += 1;
  }

  const args: Record<string, string | string[] | undefined> = {};
  let cursor = 0;

  for (const declared of spec.args) {
    if (declared.variadic) {
      args[declared.name] = positionals.slice(cursor);
      cursor = positionals.length;
      continue;
    }

    const value = positionals[cursor];
    cursor += 1;

    if (value !== undefined) {
      args[declared.name] = value;
      continue;
    }

    if (declared.default !== undefined) {
      args[declared.name] = declared.default;
      continue;
    }

    if (declared.required) {
      errors.push(`Missing required argument <${declared.name}>.`);
    }

    args[declared.name] = undefined;
  }

  if (cursor < positionals.length) {
    const extra = positionals.slice(cursor);
    errors.push(
      `Unexpected argument${extra.length === 1 ? "" : "s"} ` +
        `${extra.map((value) => JSON.stringify(value)).join(", ")}. ` +
        `Command "${spec.commandName}" takes ${spec.args.length} argument` +
        `${spec.args.length === 1 ? "" : "s"}.`,
    );
  }

  const options: Record<string, string | number | boolean | undefined> = {};

  for (const declared of spec.options) {
    const supplied = raw.get(declared.name);

    if (declared.type === "boolean") {
      options[declared.name] =
        supplied === undefined
          ? (declared.default ?? false)
          : Boolean(supplied);
      continue;
    }

    if (supplied === undefined) {
      if (declared.default !== undefined) {
        options[declared.name] = declared.default;
      } else if (declared.required) {
        errors.push(`Missing required option --${kebab(declared.name)}.`);
        options[declared.name] = undefined;
      } else {
        options[declared.name] = undefined;
      }
      continue;
    }

    const value = String(supplied);

    if (declared.type === "number") {
      const parsed = Number(value);
      // `Number("")` is 0 and `Number(" ")` is 0, which is how a typo becomes a
      // plausible-looking number. Reject anything that was not written as one.
      if (value.trim() === "" || !Number.isFinite(parsed)) {
        errors.push(
          `Option --${kebab(declared.name)} expects a number, but got ` +
            `${JSON.stringify(value)}.`,
        );
        options[declared.name] = undefined;
      } else {
        options[declared.name] = parsed;
      }
      continue;
    }

    options[declared.name] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, args, options };
}
