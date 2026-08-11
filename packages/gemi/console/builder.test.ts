import { describe, expect, test } from "vitest";

import { Command } from "./Command";
import { defineCommand, isUnfinishedBuilder } from "./builder";

/**
 * The builder's run-time half: what it produces, and what it refuses.
 *
 * The type tests beside this file cover the inference, which is the reason the
 * builder exists. What is left is the handful of declarations that are wrong in
 * a way no type can express — a variadic argument with something after it, an
 * argument that is both required and defaulted — and the shape of the class that
 * comes out the other end, which everything downstream reads.
 *
 * Every refusal here throws at *declaration* time rather than when the command
 * runs. That is deliberate: these are mistakes in the application's own source,
 * and the author is looking at the file right now. Surfacing them later means
 * showing a confusing usage error to an operator who cannot fix it.
 */

describe("what the builder produces", () => {
  test("a Command subclass, which is what discovery looks for", () => {
    const Produced = defineCommand("demo").handle(() => {});

    expect(Object.prototype.isPrototypeOf.call(Command, Produced)).toBe(true);
    expect(Produced).not.toBe(Command);
  });

  test("the statics the runner and the help renderer read", () => {
    const Produced = defineCommand("send-digest")
      .describe("Send the weekly digest")
      .arg("segment", { required: true })
      .option("dryRun", { type: "boolean" })
      .handle(() => {});

    expect(Produced.commandName).toBe("send-digest");
    expect(Produced.description).toBe("Send the weekly digest");
    expect(Produced.args).toEqual([{ name: "segment", required: true }]);
    expect(Produced.options).toEqual([{ name: "dryRun", type: "boolean" }]);
  });

  /**
   * An anonymous class expression reports `name === ""`, and the duplicate-name
   * error's whole job is to say *which two*. Without this it would say neither.
   */
  test("carries the command name as its class name", () => {
    expect(defineCommand("db:seed").handle(() => {}).name).toBe("db:seed");
  });

  /**
   * The statics are a snapshot, not a window onto the builder.
   *
   * The builder goes on owning its `args`/`options` arrays and pushing to them,
   * so storing the instances themselves let a chain reach back into a class it
   * had already produced. Both `--help` and the parser read these statics, so a
   * finished command's printed usage and accepted arguments could change
   * afterwards.
   */
  test("copies the declarations, so a later .arg() cannot reach back in", () => {
    const builder = defineCommand("demo").arg("first");
    const Produced = builder.handle(() => {});

    builder.arg("late").option("later", { type: "boolean" });

    expect(Produced.args).toEqual([{ name: "first" }]);
    expect(Produced.options).toEqual([]);
  });

  test("two commands off one builder do not share a schema", () => {
    const builder = defineCommand("demo");
    const First = builder.handle(() => {});
    const Second = builder.arg("only-on-second").handle(() => {});

    expect(First.args).toEqual([]);
    expect(Second.args).toEqual([{ name: "only-on-second" }]);
  });

  test("runs the handler it was given, and passes the context through", () => {
    const Produced = defineCommand("demo").handle(
      (ctx: any) => `saw ${ctx.args.who}`,
    );

    expect(new Produced().run({ args: { who: "world" } })).toBe("saw world");
  });

  test("declaration order is preserved, which is what makes positionals work", () => {
    const Produced = defineCommand("demo")
      .arg("first")
      .arg("second")
      .arg("third")
      .handle(() => {});

    expect(Produced.args.map((arg) => arg.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("names that cannot be run", () => {
  /**
   * Aimed at one specific reader: somebody who knows Laravel and reaches for
   * `defineCommand("mail:send {user} {--queue}")`. Without this they get a
   * command registered under a name containing spaces, which can never be typed
   * and so never runs, and no explanation of why.
   */
  test("a Laravel signature string is refused, pointing at .arg and .option", () => {
    expect(() => defineCommand("mail:send {user} {--queue}")).toThrow(
      /does not parse a signature string/,
    );
    expect(() => defineCommand("mail:send {user}")).toThrow(/\.arg\(\)/);
  });

  test("whitespace alone is enough to refuse", () => {
    expect(() => defineCommand("send digest")).toThrow(/Invalid command name/);
  });

  test("an empty name is refused", () => {
    expect(() => defineCommand("  ")).toThrow(/cannot be empty/);
  });

  test("the ordinary shapes are accepted", () => {
    expect(defineCommand("send-digest").handle(() => {}).commandName).toBe(
      "send-digest",
    );
    expect(defineCommand("db:seed").handle(() => {}).commandName).toBe(
      "db:seed",
    );
  });
});

describe("declarations that contradict themselves", () => {
  test("an argument cannot be both required and defaulted", () => {
    expect(() =>
      defineCommand("demo").arg("env", { required: true, default: "staging" }),
    ).toThrow(/both required and has a default/);
  });

  /**
   * A variadic collects whatever is left and is an empty list when there is
   * nothing, so there is no "absent" for a default to fill. Refused rather than
   * ignored, because a declaration the parser silently drops reads — to whoever
   * wrote it — exactly like one it honours. (`required` on a variadic *does*
   * mean something, and `parse.ts` enforces it: at least one.)
   */
  test("a variadic argument cannot have a default", () => {
    expect(() =>
      defineCommand("demo").arg("files", { variadic: true, default: "x" }),
    ).toThrow(/variadic and has a default/);
  });

  /**
   * A variadic argument collects everything that follows, so anything declared
   * after it could never receive a value — the command would run, and one of its
   * arguments would be permanently empty with nothing to say so.
   */
  test("nothing may be declared after a variadic argument", () => {
    expect(() =>
      defineCommand("demo").arg("rest", { variadic: true }).arg("after"),
    ).toThrow(/must be declared last/);
  });

  test("a name declared twice is refused, for arguments and options alike", () => {
    expect(() => defineCommand("demo").arg("who").arg("who")).toThrow(
      /declares the argument "who" twice/,
    );
    expect(() =>
      defineCommand("demo")
        .option("loud", { type: "boolean" })
        .option("loud", { type: "boolean" }),
    ).toThrow(/declares the option "loud" twice/);
  });

  test("two options cannot share an alias", () => {
    expect(() =>
      defineCommand("demo")
        .option("limit", { type: "number", alias: "l" })
        .option("locale", { type: "string", alias: "l" }),
    ).toThrow(/both use the alias "-l"/);
  });
});

describe("recognising a chain that was never finished", () => {
  /**
   * The one silence the builder introduces. A builder that never called
   * `.handle()` is a plain object rather than a class, so `discoverClasses`
   * discards it along with every constant a command file happens to export — and
   * the command disappears from `gemi run` with nothing raised.
   *
   * `discoverCommands` uses this to tell that case apart from an ordinary
   * non-class export and refuse the file by name.
   */
  test("an unfinished builder is recognisable, and a finished one is not", () => {
    expect(isUnfinishedBuilder(defineCommand("demo"))).toBe(true);
    expect(isUnfinishedBuilder(defineCommand("demo").arg("who"))).toBe(true);
    expect(isUnfinishedBuilder(defineCommand("demo").handle(() => {}))).toBe(
      false,
    );
  });

  test("the ordinary exports a command file carries are not mistaken for one", () => {
    for (const value of [undefined, null, {}, [], "x", 42, () => {}, Command]) {
      expect(isUnfinishedBuilder(value)).toBe(false);
    }
  });

  /**
   * "Unfinished" has to mean *this chain produced nothing*, not *this export is
   * still a builder object*. The two differ for the natural way to share
   * declarations between commands:
   *
   *     export const base = defineCommand("reindex").option("verbose", …);
   *     export default base.handle(async () => {});
   *
   * Both exports are visible to discovery, and `base` is a builder that did
   * produce a command. Keying off the shape alone made that file throw — and
   * because the throw happens before the registry is built, it took *every other
   * command in the project* down with it, under a message that was untrue.
   */
  test("a chain that did reach .handle() is finished, however it was held", () => {
    const base = defineCommand("reindex").option("verbose", {
      type: "boolean",
    });

    expect(isUnfinishedBuilder(base)).toBe(true);

    base.handle(() => {});

    expect(isUnfinishedBuilder(base)).toBe(false);
  });
});
