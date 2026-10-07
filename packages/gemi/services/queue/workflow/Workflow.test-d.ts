import { describe, expectTypeOf, test } from "vitest";

import type { BatchStatus } from "../batch";
import { Job } from "../Job";
import type { Step } from "./Step";
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
  });
});
