/**
 * Type-level tests for `probe`: `run` and `expression` take the probe's
 * arguments and `run` resolves to its (awaited) result, typed from the probe
 * module's default export or from the function's own type.
 *
 * Run with `bun run typecheck` (or `bun run test:types`).
 */
import { describe, expectTypeOf, test } from "vitest";
import { probe, type ProbePage } from "./index";

type Box = { w: number; h: number };
type LayoutModule = {
  default: (boxes: Box[], label: string) => Promise<{ total: number }>;
};

declare const page: ProbePage;

describe("probe", () => {
  test("is typed from the module's default export", () => {
    const readLayout = probe<LayoutModule>("utils/layout");
    expectTypeOf(readLayout.run).parameters.toEqualTypeOf<[ProbePage, Box[], string]>();
    expectTypeOf(readLayout.run).returns.toEqualTypeOf<Promise<{ total: number }>>();
    expectTypeOf(readLayout.expression).parameters.toEqualTypeOf<[Box[], string]>();
    // @ts-expect-error the label is missing
    void readLayout.run(page, []);
  });

  test("or from the function's own type", () => {
    const count = probe<(selector: string) => number>("utils/count");
    expectTypeOf(count.run).returns.toEqualTypeOf<Promise<number>>();
    // @ts-expect-error a number is not a selector
    void count.run(page, 1);
  });

  test("a puppeteer- or playwright-shaped page fits ProbePage", () => {
    // Their `evaluate` is generic and overloaded; one that takes a string
    // expression is all a probe needs.
    type DriverPage = {
      evaluate<T, A extends unknown[]>(fn: string | ((...args: A) => T), ...args: A): Promise<Awaited<T>>;
    };
    expectTypeOf<DriverPage>().toMatchTypeOf<ProbePage>();
  });
});
