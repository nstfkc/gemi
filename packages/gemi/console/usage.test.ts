import { describe, expect, test } from "vitest";

import { defineCommand } from "./builder";
import { renderUsage } from "./usage";

/**
 * What `--help` prints, checked against what the parser actually accepts.
 *
 * The whole reason `usage.ts` renders from the declared statics rather than
 * from hand-written strings is that help which describes a flag the parser
 * rejects is worse than no help — it sends the reader to try something that
 * cannot work. The `-h, --help` line was the one place that reasoning had a
 * hole: it was printed unconditionally, including for commands that had taken
 * one or both of those spellings for themselves.
 */

const usage = (build: (chain: any) => any) =>
  renderUsage(build(defineCommand("demo")).handle(() => {}));

describe("the help line", () => {
  test("is offered in both spellings when the command claims neither", () => {
    expect(usage((c: any) => c)).toContain("-h, --help");
  });

  test("drops the alias when the command took -h for something else", () => {
    const rendered = usage((c: any) =>
      c.option("host", { type: "string", alias: "h" }),
    );

    // `parse.ts` still answers `--help` here, so it is still advertised — but
    // only in the spelling that works. Two contradictory `-h` entries, one of
    // them dead, was the bug.
    expect(rendered).toContain("--help");
    expect(rendered).not.toContain("-h, --help");
    expect(rendered).toContain("-h, --host");
  });

  test("falls back to the alias when the command took the long spelling", () => {
    const rendered = usage((c: any) => c.option("help", { type: "boolean" }));

    expect(rendered).toContain("-h ");
    expect(rendered).not.toContain("-h, --help");
  });

  test("says nothing when the command claimed both", () => {
    const rendered = usage((c: any) =>
      c.option("help", { type: "boolean", alias: "h" }),
    );

    expect(rendered).not.toContain("Show this message");
  });
});

describe("arguments", () => {
  test("a required variadic reads as mandatory, which the parser now enforces", () => {
    expect(
      usage((c: any) => c.arg("files", { required: true, variadic: true })),
    ).toContain("<files...>");
  });

  test("an optional one reads as optional", () => {
    expect(usage((c: any) => c.arg("files", { variadic: true }))).toContain(
      "[files...]",
    );
  });
});
