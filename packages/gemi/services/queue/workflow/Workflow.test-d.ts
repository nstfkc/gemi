import { describe, expectTypeOf, test } from "vitest";

import type { BatchStatus } from "../batch";
import { Job } from "../Job";
import type { SourceRef } from "./ItemSource";
import type { ChunkContext, EachProblem, EachSummary, ItemContext, Step } from "./Step";
import { Workflow, type WorkflowStatus } from "./Workflow";

class BuildPage extends Job {
  static name = "BuildPage";
  run(_pageId: string, _importId: number) {}
}

class ImportSite extends Workflow {
  static name = "ImportSite";
  async run(step: Step, importId: number, pages: string[]) {
    const crawled = await step.run("crawl", () => ({ count: pages.length }));
    expectTypeOf(crawled).toEqualTypeOf<{ count: number }>();
    const chosen = await step.waitFor<string[]>("chosen", { timeout: "7d" });
    expectTypeOf(chosen).toEqualTypeOf<string[]>();
    const batch = await step.batch(
      "build",
      BuildPage,
      chosen.map((id) => [id, importId] as const),
    );
    expectTypeOf(batch).toEqualTypeOf<BatchStatus>();
    // @ts-expect-error the tuple is BuildPage's run arguments
    await step.batch("bad", BuildPage, [[importId, "x"]]);
    const summary = await step.each(
      "rows",
      {
        count: pages.length,
        item: async (index) => ({ sku: pages[index]!, index }),
        key: (row) => row.sku,
        concurrency: 2,
        timeout: "30s",
      },
      async (row, ctx) => {
        expectTypeOf(row).toEqualTypeOf<{ sku: string; index: number }>();
        expectTypeOf(ctx).toEqualTypeOf<ItemContext>();
        if (!row.sku) ctx.skip("no sku");
      },
    );
    expectTypeOf(summary).toEqualTypeOf<EachSummary>();
    const rows = await step.source("source", async function* () {
      yield { line: 1, name: "a" };
    });
    expectTypeOf(rows).toEqualTypeOf<SourceRef<{ line: number; name: string }>>();
    await step.each("from-source", { source: rows }, (row) => {
      expectTypeOf(row).toEqualTypeOf<{ line: number; name: string }>();
    });
    await step.each(
      "chunked",
      {
        source: rows,
        chunk: 25,
        transaction: true,
        throttle: [{ key: "images", limit: 20, window: "1s" }],
        maxFailures: { ratio: 0.5, after: 20 },
      },
      (batch, ctx) => {
        expectTypeOf(batch).toEqualTypeOf<Array<{ line: number; name: string }>>();
        expectTypeOf(ctx).toEqualTypeOf<ChunkContext>();
        ctx.skip(0, "no name");
      },
    );
    await step.each("released", { count: 1, item: () => 1, maxFailures: 3 }, (_n, ctx) => {
      expectTypeOf(ctx.release).returns.toEqualTypeOf<never>();
    });
    // @ts-expect-error a source and a count are two ways of saying the same thing
    await step.each("both", { source: rows, count: 1 }, () => {});
    // @ts-expect-error a key is a string or a number
    await step.each("bad-key", { count: 1, item: () => 1, key: () => ({}) }, () => {});
    await step.sleep("settle", "30s");
    // @ts-expect-error not a duration
    await step.sleep("never", "soon");
    return crawled.count;
  }
}

describe("Workflow", () => {
  test("start takes run's arguments after step", () => {
    expectTypeOf(ImportSite.start(1, ["a"])).toEqualTypeOf<Promise<string>>();
    // @ts-expect-error importId is a number
    ImportSite.start("1", ["a"]);
    // @ts-expect-error pages is missing
    ImportSite.start(1);
  });

  test("find, signal and cancel work from any class", () => {
    expectTypeOf(Workflow.find("id")).toEqualTypeOf<Promise<WorkflowStatus | null>>();
    expectTypeOf(ImportSite.signal("id", "chosen", ["a"])).toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(Workflow.cancel("id")).toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(Workflow.items("id", "rows", { status: "failed" })).toEqualTypeOf<
      Promise<EachProblem[]>
    >();
  });
});
