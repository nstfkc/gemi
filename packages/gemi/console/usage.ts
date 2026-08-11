import type { CommandClass } from "./Command";
import { kebab } from "./parse";

/**
 * Everything `gemi run` prints when it is not running a command.
 *
 * Rendered from the same statics `parse.ts` reads, so the help cannot describe a
 * flag the parser does not accept. That is the only reason this is not a set of
 * template literals next to the code that needs them.
 */

function pad(entries: Array<[string, string]>, indent = "  "): string[] {
  const width = entries.reduce((max, [left]) => Math.max(max, left.length), 0);
  return entries.map(([left, right]) =>
    right === ""
      ? `${indent}${left}`
      : `${indent}${left.padEnd(width)}  ${right}`,
  );
}

function argSlot(arg: {
  name: string;
  required?: boolean;
  variadic?: boolean;
}): string {
  const inner = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${inner}>` : `[${inner}]`;
}

/**
 * The `--help` line, listed only in the spellings the command left free.
 *
 * `parse.ts` yields `--help` to a command that declares an option called `help`
 * and `-h` to one that declares that alias, independently. Printing an
 * unconditional `-h, --help` meant a command with a `-h, --host` was shown two
 * contradictory `-h` entries, one of which did nothing — help that lies about
 * the parser is worse than no help line at all.
 */
function helpEntry(command: CommandClass): Array<[string, string]> {
  const claimed = (
    predicate: (option: CommandClass["options"][number]) => boolean,
  ) => command.options.some(predicate);

  const longTaken = claimed(
    (option) => option.name === "help" || kebab(option.name) === "help",
  );
  const shortTaken = claimed(
    (option) => "alias" in option && option.alias === "h",
  );

  if (longTaken && shortTaken) return [];
  if (longTaken) return [["-h", "Show this message"]];

  return [[`${shortTaken ? "" : "-h, "}--help`, "Show this message"]];
}

export function renderUsage(command: CommandClass): string {
  const lines: string[] = [];

  const slots = command.args.map(argSlot).join(" ");
  const usage = [
    "gemi run",
    command.commandName,
    command.options.length > 0 ? "[options]" : "",
    slots,
  ]
    .filter(Boolean)
    .join(" ");

  lines.push(`Usage: ${usage}`);

  if (command.description) {
    lines.push("", command.description);
  }

  if (command.args.length > 0) {
    lines.push("", "Arguments:");
    lines.push(
      ...pad(
        command.args.map((arg) => {
          const notes = [
            arg.description ?? "",
            arg.default !== undefined
              ? `(default: ${JSON.stringify(arg.default)})`
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          return [argSlot(arg), notes] as [string, string];
        }),
      ),
    );
  }

  lines.push("", "Options:");
  lines.push(
    ...pad([
      ...command.options.map((option) => {
        const alias =
          "alias" in option && option.alias ? `-${option.alias}, ` : "";
        const value = option.type === "boolean" ? "" : ` <${option.type}>`;
        const notes = [
          option.description ?? "",
          option.default !== undefined
            ? `(default: ${JSON.stringify(option.default)})`
            : "",
          "required" in option && option.required ? "(required)" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return [`${alias}--${kebab(option.name)}${value}`, notes] as [
          string,
          string,
        ];
      }),
      ...helpEntry(command),
    ]),
  );

  return lines.join("\n");
}

export function renderList(
  commands: CommandClass[],
  source: { declared: boolean; dir: string },
): string {
  const heading = source.declared
    ? `${commands.length} command${commands.length === 1 ? "" : "s"} declared in app/config/command.ts:`
    : `Commands in ${source.dir}:`;

  if (commands.length === 0) {
    return source.declared
      ? `app/config/command.ts declares no commands.\n\n` +
          `Remove the \`commands\` key from that slice to discover the classes ` +
          `under ${source.dir} instead — a declared list wins, and an empty one ` +
          `means "none, and I mean it".`
      : `No commands found in ${source.dir}.\n\n` +
          `A command is registered by existing: write a file there that exports ` +
          `a \`defineCommand(...).handle(...)\` chain and it will appear here.`;
  }

  const sorted = [...commands].sort((a, b) =>
    a.commandName < b.commandName ? -1 : a.commandName > b.commandName ? 1 : 0,
  );

  return [
    heading,
    "",
    ...pad(
      sorted.map(
        (command) =>
          [command.commandName, command.description] as [string, string],
      ),
    ),
    "",
    "Run one with `gemi run <name>`, and see its arguments with " +
      "`gemi run <name> --help`.",
  ].join("\n");
}
