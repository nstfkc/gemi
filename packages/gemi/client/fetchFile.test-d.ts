/**
 * Type-level tests for `fetchBlob` / `fetchText` (#907), against a file table
 * built the way `gemi.d.ts` builds the app's `FileRPC`. Every
 * `@ts-expect-error` is a call that must not compile.
 */
import { describe, expectTypeOf, test } from "vitest";

import { ApiRouter, type CreateFileRPC } from "../http/ApiRouter";
import {
  fetchBlob,
  fetchText,
  type FetchFileArgs,
  type FetchFileOptions,
  type FetchedBlob,
  type FetchedText,
  type FilePathOf,
} from "./fetchFile";

class Api extends ApiRouter {
  routes = {
    "/json": this.get(() => ({ ok: true })),
    "/pages/:pageId/post/image": this.stream(() => null),
    "/exports/report.csv": this.file(() => null),
  };
}

type Table = CreateFileRPC<Api>;

describe("fetchBlob / fetchText types", () => {
  test("paths are the api's file routes; any string without a table", () => {
    expectTypeOf<FilePathOf<Table>>().toEqualTypeOf<
      "/pages/:pageId/post/image" | "/exports/report.csv"
    >();
    expectTypeOf<FilePathOf<{}>>().toEqualTypeOf<string>();
  });

  test("a path with params requires them", () => {
    expectTypeOf<FetchFileArgs<"/exports/report.csv">>().toEqualTypeOf<
      [options?: FetchFileOptions<"/exports/report.csv">]
    >();
    // @ts-expect-error options (and `params`) are required for a param path
    void fetchBlob("/pages/:pageId/post/image" as const);
    // @ts-expect-error `params` is required for a param path
    void fetchBlob("/pages/:pageId/post/image" as const, { search: { format: "png" } });
    // @ts-expect-error the param is `pageId`
    void fetchBlob("/pages/:pageId/post/image" as const, { params: { id: "1" } });
    void fetchBlob("/pages/:pageId/post/image" as const, {
      params: { pageId: "p1" },
      search: { format: "png", scale: 2, missing: undefined },
    });
  });

  test("a path without params takes no options", () => {
    void fetchText("/exports/report.csv" as const);
    void fetchText("/exports/report.csv" as const, { init: { cache: "no-store" } });
  });

  test("results", () => {
    expectTypeOf(fetchBlob("/exports/report.csv")).resolves.toEqualTypeOf<FetchedBlob>();
    expectTypeOf(fetchText("/exports/report.csv")).resolves.toEqualTypeOf<FetchedText>();
    expectTypeOf<FetchedBlob["blob"]>().toEqualTypeOf<Blob>();
    expectTypeOf<FetchedText["text"]>().toEqualTypeOf<string>();
    expectTypeOf<FetchedBlob["filename"]>().toEqualTypeOf<string | null>();
  });
});
