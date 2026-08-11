import { describe, expectTypeOf, test } from "vitest";

import { defineCommand } from "./builder";
import type { CommandContext } from "./context";

/**
 * The builder's whole reason for existing, and the only file that can check it.
 *
 * A class body cannot type a command's own handler: TypeScript does not
 * contextually type an overriding method's parameters from the base-class method
 * it overrides, so `static args` next to `run(ctx)` leaves `ctx` an implicit
 * `any` — and so does a configured base class returned by a `Command.define()`.
 * A function expression passed as an argument *is* contextually typed, which is
 * why `.handle(fn)` is the shape.
 *
 * None of that is observable at run time. A regression in the inference types —
 * a `const` type parameter dropped, a conditional branch that stops firing —
 * would leave every other test in this repository green while quietly handing
 * every handler an `any`. Hence the last block: **asserting a property of `any`
 * succeeds**, so a suite that only checked `toEqualTypeOf<string>()` would pass
 * just as happily on a builder that had stopped inferring anything at all.
 */

describe("arguments", () => {
  test("required is present, bare is optional", () => {
    defineCommand("demo")
      .arg("required", { required: true })
      .arg("bare")
      .handle(({ args }) => {
        expectTypeOf(args.required).toEqualTypeOf<string>();
        expectTypeOf(args.bare).toEqualTypeOf<string | undefined>();
      });
  });

  test("a default makes an argument always present", () => {
    defineCommand("demo")
      .arg("env", { default: "staging" })
      .handle(({ args }) => {
        expectTypeOf(args.env).toEqualTypeOf<string>();
      });
  });

  test("a variadic argument is a list, never undefined", () => {
    defineCommand("demo")
      .arg("rest", { variadic: true })
      .handle(({ args }) => {
        expectTypeOf(args.rest).toEqualTypeOf<string[]>();
      });
  });

  test("a description alone does not make an argument present", () => {
    defineCommand("demo")
      .arg("who", { description: "Who to greet" })
      .handle(({ args }) => {
        expectTypeOf(args.who).toEqualTypeOf<string | undefined>();
      });
  });
});

describe("options", () => {
  test("a boolean is always a boolean", () => {
    defineCommand("demo")
      .option("dryRun", { type: "boolean" })
      .handle(({ options }) => {
        expectTypeOf(options.dryRun).toEqualTypeOf<boolean>();
      });
  });

  test("a number is optional until it has a default or is required", () => {
    defineCommand("demo")
      .option("bare", { type: "number" })
      .option("defaulted", { type: "number", default: 50 })
      .option("required", { type: "number", required: true })
      .handle(({ options }) => {
        expectTypeOf(options.bare).toEqualTypeOf<number | undefined>();
        expectTypeOf(options.defaulted).toEqualTypeOf<number>();
        expectTypeOf(options.required).toEqualTypeOf<number>();
      });
  });

  test("a string behaves the same way, and stays a string", () => {
    defineCommand("demo")
      .option("bare", { type: "string" })
      .option("defaulted", { type: "string", default: "x" })
      .handle(({ options }) => {
        expectTypeOf(options.bare).toEqualTypeOf<string | undefined>();
        expectTypeOf(options.defaulted).toEqualTypeOf<string>();
      });
  });
});

describe("accumulation across the chain", () => {
  test("every declaration survives, in any order, past describe()", () => {
    defineCommand("demo")
      .arg("one", { required: true })
      .describe("interleaved on purpose")
      .option("two", { type: "number", default: 1 })
      .arg("three")
      .option("four", { type: "boolean" })
      .handle(({ args, options }) => {
        expectTypeOf(args.one).toEqualTypeOf<string>();
        expectTypeOf(args.three).toEqualTypeOf<string | undefined>();
        expectTypeOf(options.two).toEqualTypeOf<number>();
        expectTypeOf(options.four).toEqualTypeOf<boolean>();
      });
  });

  test("a name that was never declared is an error", () => {
    defineCommand("demo")
      .arg("who", { required: true })
      .handle(({ args, options }) => {
        // Reading a name nothing declared is an error, and suppressing it gets
        // you `any` — which is what the assertions below are asserting, and why
        // they are written as bindings rather than as bare member reads.
        // @ts-expect-error - `whom` was never declared
        const missingArg = args.whom;
        // @ts-expect-error - no options were declared at all
        const missingOption = options.anything;

        expectTypeOf(missingArg).toBeAny();
        expectTypeOf(missingOption).toBeAny();
      });
  });
});

describe("the context itself", () => {
  test("carries the writers and the raw tail", () => {
    defineCommand("demo").handle((ctx) => {
      expectTypeOf(ctx.line).toBeFunction();
      expectTypeOf(ctx.error).toBeFunction();
      expectTypeOf(ctx.argv).toEqualTypeOf<readonly string[]>();
      expectTypeOf(ctx.fail).returns.toBeNever();
    });
  });

  /**
   * The assertion the rest of this file rests on.
   *
   * `expectTypeOf<any>().toEqualTypeOf<string>()` passes. So does every other
   * check above, if the inference collapses and the handler starts receiving
   * `any` — which is exactly what a class body does today and what this whole
   * design exists to avoid. Without this, the suite cannot tell the two apart.
   */
  test("is never any — the failure every other assertion here would hide", () => {
    defineCommand("demo")
      .arg("who", { required: true })
      .option("loud", { type: "boolean" })
      .handle((ctx) => {
        expectTypeOf(ctx).not.toBeAny();
        expectTypeOf(ctx.args).not.toBeAny();
        expectTypeOf(ctx.options).not.toBeAny();
        expectTypeOf(ctx.args.who).not.toBeAny();
        expectTypeOf(ctx.options.loud).not.toBeAny();
        expectTypeOf(ctx).toMatchTypeOf<CommandContext>();
      });
  });
});

describe("the handler's return type", () => {
  test("nothing, a number, or a promise of either", () => {
    defineCommand("demo").handle(() => {});
    defineCommand("demo").handle(() => 0);
    defineCommand("demo").handle(async () => 3);
    defineCommand("demo").handle(async () => {});

    // @ts-expect-error - a string is not an exit code
    defineCommand("demo").handle(() => "done");
  });
});
