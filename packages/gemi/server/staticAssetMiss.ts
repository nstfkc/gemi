import { RESERVED_ROUTE_PREFIX } from "../services/router/ViewRouteDispatcher";

/**
 * A JavaScript module under `/assets/` — the only shape a client build chunk
 * has. Vite writes every chunk into `assets/` with a `.js` extension (`.mjs`
 * is accepted for a build configured to emit it).
 *
 * The extension is matched at the end of the path, not anywhere in it:
 * `includes(".js")` also matched `app.js.map` and `data.json`, so a missing
 * source map was answered with a script that reloads the page.
 */
const BUILD_CHUNK = new RegExp(`^${RESERVED_ROUTE_PREFIX}/.+\\.m?js$`);

export function isBuildChunkPath(pathname: string): boolean {
  return BUILD_CHUNK.test(pathname);
}

/**
 * The answer to a static-looking request with no file behind it in
 * `dist/client`, or `undefined` to hand the request to the app.
 *
 * A missing build chunk is almost always a document rendered by another
 * release asking for its own chunks — a deploy between page load and a lazy
 * `import()`, or two releases serving at once. The page cannot continue with
 * the chunk it wanted, so it gets a module that reloads it onto this release's
 * document. Only for build chunks: outside `/assets/` a `.js` path may be an
 * app route, and a classic `<script src>` answered with a reload reloads
 * forever.
 *
 * `no-store` because the stub is a stand-in for one release's chunk, served
 * under that chunk's URL. Cached — by the browser or by an edge in front of
 * the origin — it would outlive the deploy that caused it and answer the
 * request after the real chunk is back.
 */
export function staticAssetMiss(pathname: string, distPath: string): Response | undefined {
  if (isBuildChunkPath(pathname)) {
    return new Response(
      `if(caches){caches?.delete("${distPath}")}window.location.reload();export {}`,
      {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // `/assets` is reserved for build output (the router rejects routes there
  // at boot), so a miss is a miss — 404 without paying for an SSR render.
  if (pathname === RESERVED_ROUTE_PREFIX || pathname.startsWith(`${RESERVED_ROUTE_PREFIX}/`)) {
    return new Response("Not found", { status: 404 });
  }

  // Anywhere else the static-file pattern matched on extension alone, so this
  // may well be an app route — a file route like
  // `this.file(() => Bun.file(...))` mounted at `/files/logo.svg` lands here
  // too. The app answers it rather than a 404 on its behalf.
  return undefined;
}
