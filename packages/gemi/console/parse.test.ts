import { describe, expect, test } from "vitest";

import type { CommandArgument, CommandOption } from "./Command";
import { kebab, parseArgv, wantsHelp, type CommandSpec } from "./parse";

/**
 * What an operator typed, against what a command declared.
 *
 * Every off-by-one in argument handling lives here, which is why `parse.ts` is a
 * pure function: none of this needs a project on disk, a spawned process or a
 * booted container, so all of it can be cheap and there can be a lot of it.
 *
 * The cases worth having are the ones where a wrong answer still looks like an
 * answer — `--times abc` arriving as `NaN`, a default overwriting a value the
 * operator supplied, a flag after `--` being read as a flag. A parser that
 * *throws* on bad input is easy to notice; one that quietly produces a plausible
 * number is not.
 */

const spec = (
  args: CommandArgument[] = [],
  options: CommandOption[] = [],
): CommandSpec => ({ commandName: "demo", args, options });

const ok = (result: ReturnType<typeof parseArgv>) => {
  if (!result.ok) throw new Error(`expected a parse, got: ${result.errors}`);
  return result;
};

const errors = (result: ReturnType<typeof parseArgv>) => {
  if (result.ok) throw new Error("expected usage errors, got a parse");
  return result.errors;
};

describe("kebab", () => {
  test("declared camelCase becomes the flag an operator types", () => {
    expect(kebab("dryRun")).toBe("dry-run");
    expect(kebab("limit")).toBe("limit");
    expect(kebab("maxDBConnections")).toBe("max-db-connections");
  });
});

describe("positional arguments", () => {
  test("fill in declaration order", () => {
    const result = ok(
      parseArgv(spec([{ name: "from" }, { name: "to" }]), ["a", "b"]),
    );

    expect(result.args).toEqual({ from: "a", to: "b" });
  });

  test("a missing required argument is a usage error", () => {
    expect(
      errors(parseArgv(spec([{ name: "who", required: true }]), [])),
    ).toEqual(["Missing required argument <who>."]);
  });

  test("a missing optional argument is undefined, not an error", () => {
    expect(ok(parseArgv(spec([{ name: "who" }]), [])).args).toEqual({
      who: undefined,
    });
  });

  test("a default fills in for an absent argument", () => {
    expect(
      ok(parseArgv(spec([{ name: "env", default: "staging" }]), [])).args,
    ).toEqual({ env: "staging" });
  });

  /**
   * The direction that matters. A default that wins over a supplied value is
   * the bug nobody reports, because the command runs and does something
   * reasonable — just not the thing that was asked for.
   */
  test("a supplied value wins over the default", () => {
    expect(
      ok(parseArgv(spec([{ name: "env", default: "staging" }]), ["prod"])).args,
    ).toEqual({ env: "prod" });
  });

  test("a variadic argument collects the tail, and is [] when it takes none", () => {
    const declared = spec([
      { name: "first" },
      { name: "rest", variadic: true },
    ]);

    expect(ok(parseArgv(declared, ["a", "b", "c"])).args).toEqual({
      first: "a",
      rest: ["b", "c"],
    });
    expect(ok(parseArgv(declared, ["a"])).args).toEqual({
      first: "a",
      rest: [],
    });
  });

  /**
   * `usage.ts` prints `<files...>` for this declaration, which tells the
   * operator it is mandatory. Ignoring `required` meant `gemi run import-files`
   * with the paths forgotten booted the application, ran the handler over an
   * empty list and exited 0 — a no-op that reads as a successful import.
   */
  test("a required variadic argument needs at least one value", () => {
    const declared = spec([{ name: "files", required: true, variadic: true }]);

    expect(errors(parseArgv(declared, []))).toEqual([
      'Missing required argument <files...>. Command "demo" needs at least one.',
    ]);
    expect(ok(parseArgv(declared, ["a", "b"])).args).toEqual({
      files: ["a", "b"],
    });
  });

  test("an optional variadic argument is still happy with nothing", () => {
    expect(
      ok(parseArgv(spec([{ name: "files", variadic: true }]), [])).args,
    ).toEqual({ files: [] });
  });

  test("an argument the command never declared is reported, not ignored", () => {
    expect(errors(parseArgv(spec([{ name: "who" }]), ["a", "b"]))).toEqual([
      'Unexpected argument "b". Command "demo" takes 1 argument.',
    ]);
  });
});

describe("options", () => {
  const flag: CommandOption = { name: "dryRun", type: "boolean" };
  const limit: CommandOption = { name: "limit", type: "number", alias: "l" };
  const tag: CommandOption = { name: "tag", type: "string", alias: "t" };

  test("a boolean is false when absent and true when present", () => {
    expect(ok(parseArgv(spec([], [flag]), [])).options).toEqual({
      dryRun: false,
    });
    expect(ok(parseArgv(spec([], [flag]), ["--dry-run"])).options).toEqual({
      dryRun: true,
    });
  });

  test("both the kebab and the declared spelling resolve", () => {
    expect(ok(parseArgv(spec([], [flag]), ["--dryRun"])).options).toEqual({
      dryRun: true,
    });
  });

  test("--no-<flag> turns a boolean off", () => {
    expect(
      ok(parseArgv(spec([], [{ ...flag, default: true }]), ["--no-dry-run"]))
        .options,
    ).toEqual({ dryRun: false });
  });

  test("a value can be attached or separate", () => {
    expect(ok(parseArgv(spec([], [tag]), ["--tag=x"])).options).toEqual({
      tag: "x",
    });
    expect(ok(parseArgv(spec([], [tag]), ["--tag", "x"])).options).toEqual({
      tag: "x",
    });
  });

  test("aliases work, attached, separate and clustered", () => {
    expect(ok(parseArgv(spec([], [limit]), ["-l", "5"])).options.limit).toBe(5);
    expect(ok(parseArgv(spec([], [limit]), ["-l5"])).options.limit).toBe(5);
    expect(ok(parseArgv(spec([], [limit]), ["-l=5"])).options.limit).toBe(5);
    expect(
      ok(parseArgv(spec([], [{ ...flag, alias: "d" }, limit]), ["-dl", "5"]))
        .options,
    ).toEqual({ dryRun: true, limit: 5 });
  });

  /**
   * `Number("")` is `0` and `Number(" ")` is `0`, which is how an empty value
   * becomes a plausible-looking limit. A `NaN` reaching the handler is worse
   * still: every comparison against it is false, so the command does nothing and
   * reports success.
   */
  test("a number option that is not a number is a usage error", () => {
    expect(errors(parseArgv(spec([], [limit]), ["--limit", "abc"]))).toEqual([
      'Option --limit expects a number, but got "abc".',
    ]);
    expect(errors(parseArgv(spec([], [limit]), ["--limit", ""]))).toEqual([
      'Option --limit expects a number, but got "".',
    ]);
  });

  test("a number option keeps negatives and decimals", () => {
    expect(
      ok(parseArgv(spec([], [limit]), ["--limit=-2.5"])).options.limit,
    ).toBe(-2.5);
  });

  test("an option with no value is reported rather than swallowing the next flag", () => {
    expect(errors(parseArgv(spec([], [tag]), ["--tag"]))).toEqual([
      "Option --tag needs a value.",
    ]);
  });

  /**
   * The worst shape a parser bug can take: `--tag --dry-run` setting `tag` to
   * the literal `"--dry-run"` and leaving `dryRun` false means the operator's
   * dry run executes for real, with a nonsense value, and nothing is printed.
   */
  describe("a value-taking option and an option-shaped token", () => {
    const declared = spec([{ name: "rest", variadic: true }], [tag, flag]);

    test("the next option is refused, not swallowed", () => {
      expect(errors(parseArgv(declared, ["--tag", "--dry-run"]))).toEqual([
        'Option --tag needs a value, but the next token is "--dry-run", which ' +
          "is another option. If that really is the value, write --tag=--dry-run.",
      ]);
    });

    test("a bare -- is refused too, so the escape hatch survives", () => {
      expect(errors(parseArgv(declared, ["--tag", "--", "x"]))[0]).toContain(
        "Option --tag needs a value",
      );
      // And the `--` still did its job rather than vanishing into the option.
      expect(
        ok(
          parseArgv(spec([{ name: "rest", variadic: true }], [flag]), [
            "--",
            "--dry-run",
          ]),
        ).args,
      ).toEqual({ rest: ["--dry-run"] });
    });

    test("an alias refuses it as well", () => {
      expect(errors(parseArgv(declared, ["-t", "--dry-run"]))[0]).toContain(
        "Option -t needs a value",
      );
    });

    test("`=` is the way to say a value really does start with a dash", () => {
      expect(ok(parseArgv(declared, ["--tag=--dry-run"])).options.tag).toBe(
        "--dry-run",
      );
    });

    /** Both of these are values, not options, and refusing them would be wrong. */
    test("a negative number and a bare - are still values", () => {
      expect(
        ok(parseArgv(spec([], [limit]), ["--limit", "-5"])).options.limit,
      ).toBe(-5);
      expect(
        ok(parseArgv(spec([], [limit]), ["--limit", "-2.5"])).options.limit,
      ).toBe(-2.5);
      expect(ok(parseArgv(declared, ["--tag", "-"])).options.tag).toBe("-");
    });
  });

  test("an unknown option names the command", () => {
    expect(errors(parseArgv(spec([], [flag]), ["--bogus"]))).toEqual([
      'Unknown option --bogus for command "demo".',
    ]);
  });

  test("a missing required option is a usage error", () => {
    expect(
      errors(parseArgv(spec([], [{ ...tag, required: true }]), [])),
    ).toEqual(["Missing required option --tag."]);
  });

  test("defaults apply only when absent", () => {
    const declared = spec([], [{ ...limit, default: 50 }]);

    expect(ok(parseArgv(declared, [])).options.limit).toBe(50);
    expect(ok(parseArgv(declared, ["--limit", "7"])).options.limit).toBe(7);
  });

  test("a flag given a value is refused rather than quietly ignored", () => {
    expect(errors(parseArgv(spec([], [flag]), ["--dry-run=maybe"]))).toEqual([
      'Option --dry-run is a flag and takes no value, but got "maybe".',
    ]);
  });
});

describe("the -- escape", () => {
  test("everything after it is positional, however it is spelled", () => {
    const result = ok(
      parseArgv(
        spec(
          [{ name: "rest", variadic: true }],
          [{ name: "dryRun", type: "boolean" }],
        ),
        ["--", "--dry-run", "-l", "x"],
      ),
    );

    expect(result.args).toEqual({ rest: ["--dry-run", "-l", "x"] });
    expect(result.options).toEqual({ dryRun: false });
  });
});

describe("wantsHelp", () => {
  test("--help and -h ask for help", () => {
    expect(wantsHelp(spec(), ["--help"])).toBe(true);
    expect(wantsHelp(spec(), ["-h"])).toBe(true);
    expect(wantsHelp(spec(), ["run"])).toBe(false);
  });

  test("a --help after -- is the command's argument, not a request for help", () => {
    expect(wantsHelp(spec(), ["--", "--help"])).toBe(false);
  });

  /**
   * The application's schema wins over the framework's convenience. A command
   * that declares its own `--help` documents what it does, and a flag that
   * silently does something else instead is worse than no help at all.
   */
  test("a command that declares its own help keeps it", () => {
    expect(
      wantsHelp(spec([], [{ name: "help", type: "boolean" }]), ["--help"]),
    ).toBe(false);
    expect(
      wantsHelp(spec([], [{ name: "human", type: "boolean", alias: "h" }]), [
        "-h",
      ]),
    ).toBe(false);
  });

  /**
   * The two yields are independent. A `-h` alias is a claim on `-h` and nothing
   * else — treating it as a claim on `--help` too meant a command with a
   * `-h, --host` lost the long spelling it never asked for, while `usage.ts`
   * went on advertising `-h, --help` right beside the `-h, --host` that had
   * taken it.
   */
  test("declaring a -h alias does not also surrender --help", () => {
    const host = spec([], [{ name: "host", type: "string", alias: "h" }]);

    expect(wantsHelp(host, ["--help"])).toBe(true);
    expect(wantsHelp(host, ["-h", "example.com"])).toBe(false);
  });

  test("declaring a `help` option does not also surrender -h", () => {
    const own = spec([], [{ name: "help", type: "boolean" }]);

    expect(wantsHelp(own, ["--help"])).toBe(false);
    expect(wantsHelp(own, ["-h"])).toBe(true);
  });

  /**
   * A flat token scan cannot tell these apart, and got the second one wrong:
   * `--message --help` printed usage and exited 0, so the notification was never
   * sent and a wrapper branching on the exit code recorded a success.
   *
   * Now `--help` in *value* position is a value, and `--help` in option position
   * is help even when the rest of the line is a usage error — which is exactly
   * when somebody reaches for it.
   */
  describe("help against an option that takes a value", () => {
    const notify = spec(
      [{ name: "env", required: true }],
      [{ name: "message", type: "string" }],
    );

    test("a --help attached as a value is the value", () => {
      const result = ok(parseArgv(notify, ["--message=--help", "prod"]));

      expect(result.help).toBe(false);
      expect(result.options.message).toBe("--help");
    });

    test("a --help after -- is the command's argument", () => {
      expect(parseArgv(notify, ["prod", "--", "--help"]).help).toBe(false);
    });

    /**
     * The genuinely ambiguous one: the operator wanted usage, or they wanted to
     * send the literal text `--help` and the shell ate their quotes. Guessing
     * either way is silent, and guessing "help" is the worse of the two — usage
     * printed, exit 0, nothing sent. So it is reported, with both readings and
     * the fix named.
     */
    test("a --help refused as a value is reported, not answered", () => {
      const result = parseArgv(notify, ["prod", "--message", "--help"]);

      expect(result.help).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors[0]).toContain(
        "write --message=--help",
      );
    });

    test("--help still works when the invocation is otherwise unusable", () => {
      // No `env`, so this is a usage error — and help has to win, or the flag
      // is useless precisely when it is needed.
      const result = parseArgv(notify, ["--help"]);

      expect(result.help).toBe(true);
      expect(result.ok).toBe(false);
    });
  });
});

describe("several mistakes at once", () => {
  test("are all reported, so a fix is one round trip", () => {
    expect(
      errors(
        parseArgv(
          spec(
            [{ name: "who", required: true }],
            [{ name: "limit", type: "number" }],
          ),
          ["--limit", "abc", "--bogus"],
        ),
      ),
    ).toEqual([
      'Unknown option --bogus for command "demo".',
      "Missing required argument <who>.",
      'Option --limit expects a number, but got "abc".',
    ]);
  });
});
