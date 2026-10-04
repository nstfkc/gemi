import type { BunPlugin } from "bun";
import { CUSTOM_REQUEST_FILTER, customRequestParser } from "./customRequestParser";

// Server-side route/controller files whose typed `Request` params must be
// rewritten to default-instantiated arguments, e.g.
//   async (req: HttpRequest<...>) => ...   ->   async (req = new HttpRequest()) => ...
// The framework invokes handlers with NO arguments (see `RouteHandler.run` in
// `http/ApiRouter.ts`), and `new HttpRequest()` reads the current request from
// the AsyncLocalStorage context — so without this rewrite `req` is `undefined`
// at runtime. This used to be done by the gemi Vite plugin, but this code is now
// compiled by Bun (build: `Bun.build` of `app/server.ts`; dev: `bun --hot`), so
// the transform runs here instead. `gemi/vitest` applies the same transform to
// the same files for tests, which vitest loads through Vite rather than Bun.

export function gemiPlugin(): BunPlugin {
  return {
    name: "gemi-custom-request",
    setup(build) {
      build.onLoad({ filter: CUSTOM_REQUEST_FILTER }, async (args) => {
        const source = await Bun.file(args.path).text();
        const contents = await customRequestParser(source);
        return {
          contents,
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  };
}
