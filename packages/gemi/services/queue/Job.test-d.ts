import { describe, expectTypeOf, test } from "vitest";

import type { BatchStatus, JobCall } from "./batch";
import { Job } from "./Job";
import type { DispatchedBatch } from "./QueueManager";

class BuildPage extends Job {
  static name = "BuildPage";
  run(_pageId: string, _importId: number) {}
}

class ImportFinished extends Job {
  static name = "ImportFinished";
  run(_importId: number, _batch: BatchStatus) {}
}

class Notify extends Job {
  static name = "Notify";
  run(_message: string) {}
}

describe("Job.dispatchBatch", () => {
  test("takes one run tuple per job, readonly or not", () => {
    expectTypeOf(BuildPage.dispatchBatch([["a", 1]])).toEqualTypeOf<Promise<DispatchedBatch>>();
    const pages = [{ id: "a" }, { id: "b" }];
    BuildPage.dispatchBatch(pages.map((page) => [page.id, 7] as const));
    BuildPage.dispatchBatch(pages.map((page): [string, number] => [page.id, 7]));

    // @ts-expect-error the second argument is a number
    BuildPage.dispatchBatch([["a", "b"]]);
    // @ts-expect-error a tuple is missing an argument
    BuildPage.dispatchBatch([["a"]]);
  });

  test("takes job calls as callbacks", () => {
    BuildPage.dispatchBatch([["a", 1]], {
      name: "import:1",
      allowFailures: true,
      then: ImportFinished.with(1),
      catch: Notify.with("failed"),
      finally: ImportFinished.with(1),
    });
  });
});

describe("Job.with", () => {
  test("leaves out a trailing BatchStatus parameter, which the batch appends", () => {
    expectTypeOf(ImportFinished.with(1)).toEqualTypeOf<JobCall>();
    // @ts-expect-error the status is appended by the batch, not passed here
    ImportFinished.with(1, {} as BatchStatus);
    // @ts-expect-error the import id is a number
    ImportFinished.with("1");
  });

  test("takes every parameter of a run without one", () => {
    Notify.with("done");
    // @ts-expect-error the message is missing
    Notify.with();
  });
});
