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

export type ParseResult = {
  /**
   * The invocation asked for help rather than for work.
   *
   * Reported by the parse rather than by a separate scan, because whether a
   * `--help` is a request for help or the *value* of the option before it is a
   * question only something tracking option arity can answer. A flat token scan
   * reads `--message --help` as a request for help, prints usage and exits 0 —
   * so the message is never sent and a cron wrapper branching on the exit code
   * records a success for work that did not happen.
   *
   * Present on both branches, and the runner checks it first: `--help` has to
   * work on an invocation that would otherwise be a usage error, which is
   * precisely when somebody reaches for it.
   */
  help: boolean;
} & (
  | {
      ok: true;
      args: Record<string, string | string[] | undefined>;
      options: Record<string, string | number | boolean | undefined>;
    }
  | { ok: false; errors: string[] }
);

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
 * A thin read of the parse, so the two cannot disagree about what counts as a
 * `--help`. See `ParseResult["help"]` for why that question needs a parse at all.
 */
export function wantsHelp(spec: CommandSpec, argv: readonly string[]): boolean {
  return parseArgv(spec, argv).help;
}

/**
 * Whether a token is the next option rather than the previous one's value.
 *
 * `--message --dry-run` should not set `message` to the literal `"--dry-run"`
 * and leave `dryRun` false — a dry run that executes for real is the worst shape
 * a parser bug can take. So a value-taking option refuses an option-shaped
 * token and says how to override it.
 *
 * The two exceptions are both real values that happen to start with a dash: a
 * negative number, and a bare `-` (the long-standing spelling of "stdin"). For
 * anything else `--opt=value` is the escape hatch, which is how every getopt
 * since the 1980s has handled it.
 */
function looksLikeAnotherOption(token: string): boolean {
  if (token === "--") return true;
  if (!token.startsWith("-")) return false;
  if (token === "-") return false;
  if (/^-(\d|\.\d)/.test(token)) return false;
  return true;
}

export function parseArgv(
  spec: CommandSpec,
  argv: readonly string[],
): ParseResult {
  const { byName, byAlias } = optionIndex(spec.options);
  const errors: string[] = [];
  const positionals: string[] = [];
  const raw = new Map<string, string | boolean>();

  // Split, rather than one guard over both. A command that declares an option
  // called `help` has claimed `--help`, and a command that declares a `-h` alias
  // has claimed `-h` — but neither claims the other, and treating them as one
  // switch means a `.option("host", { alias: "h" })` silently removes the long
  // `--help` the command never asked for, while `usage.ts` goes on advertising
  // it. The application's schema wins over the framework's convenience, exactly
  // as far as the application actually reached.
  const helpIsFree = !byName.has("help");
  const shortHelpIsFree = !byAlias.has("h");
  let requested = false;

  // Set when the token refused as a value was itself a `--help`, which is the
  // one case where "did they want help?" has no honest answer. See the note
  // above the return.
  let ambiguous = false;

  const unknown = (token: string) =>
    errors.push(`Unknown option ${token} for command "${spec.commandName}".`);

  const needsValue = (label: string, next: string | undefined) => {
    if (next === "--help" || next === "-h") ambiguous = true;

    errors.push(
      next === undefined
        ? `Option ${label} needs a value.`
        : `Option ${label} needs a value, but the next token is ` +
            `${JSON.stringify(next)}, which is another option. If that really is ` +
            `the value, write ${label}=${next}.`,
    );
  };

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

      // Only once the command's own options have had their chance at the name.
      if (!option && key === "help" && helpIsFree) {
        requested = true;
        index += 1;
        continue;
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

      if (inline !== undefined) {
        raw.set(option.name, inline);
        index += 1;
        continue;
      }

      const next = argv[index + 1];
      if (next === undefined || looksLikeAnotherOption(next)) {
        needsValue(`--${kebab(option.name)}`, next);
        index += 1;
        continue;
      }

      raw.set(option.name, next);
      index += 2;
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
          if (chars[position] === "h" && shortHelpIsFree) {
            requested = true;
            continue;
          }
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
          break;
        }

        const next = argv[index + 1];
        if (next === undefined || looksLikeAnotherOption(next)) {
          needsValue(`-${option.alias}`, next);
          break;
        }

        raw.set(option.name, next);
        consumedNext = true;
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
      const collected = positionals.slice(cursor);
      cursor = positionals.length;
      args[declared.name] = collected;

      // `required` on a variadic means "at least one", and honouring it is the
      // only reading that matches what the operator is shown: `usage.ts` prints
      // `<files...>` for this declaration, which says mandatory. Ignoring it
      // meant `gemi run import-files` with the paths forgotten booted the
      // application, ran the handler over an empty list and exited 0 — a no-op
      // that reads as a successful import.
      if (declared.required && collected.length === 0) {
        errors.push(
          `Missing required argument <${declared.name}...>. Command ` +
            `"${spec.commandName}" needs at least one.`,
        );
      }
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

  /**
   * A `--help` refused as a value is not a request for help.
   *
   * `gemi run notify --message --help` has two readings and no way to tell them
   * apart: the operator wanted the usage, or they wanted to send the literal
   * text `--help` and the shell ate their quotes. Answering either one silently
   * is how the reviewer's case goes wrong — showing usage and exiting 0 means
   * the notification was never sent and the wrapper waiting on the status
   * records a success.
   *
   * So the ambiguity is reported instead. `needsValue` has already written the
   * sentence naming both readings and the fix (`--message=--help`), and
   * suppressing the help request here is what lets the operator see it rather
   * than a usage screen with no explanation.
   *
   * Help still wins over an ordinary usage error — `gemi run deploy --help`
   * with `<env>` missing prints the usage, because that is the invocation
   * somebody reaches for `--help` on.
   */
  const help = requested && !ambiguous;

  if (errors.length > 0) return { ok: false, help, errors };
  return { ok: true, help, args, options };
}
