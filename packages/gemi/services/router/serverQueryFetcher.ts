import { QueryError } from "../../client/QueryError";
import { HttpRequest } from "../../http/HttpRequest";
import { RequestContext } from "../../http/requestContext";
import { kernelContext } from "../../kernel/context";
import { applyParams } from "../../utils/applyParams";
import { app } from "../../foundation/app";
import { ApiRouteDispatcher } from "./ApiRouteDispatcher";
import type { ServerQueryFetcher } from "./ServerQueryStore";

/**
 * The in-process "fetch" behind every server-side query: rebuild the request
 * the browser would have sent to `/api` and run the api handler directly.
 * Mirrors what `Query.prefetch` has always done, factored out so
 * render-discovered queries go through the identical path.
 *
 * Lives apart from `ServerQueryStore` on purpose: the store is pure and
 * unit-testable, while this pulls in the whole service-container graph.
 */
export function createServerQueryFetcher(req: Request): ServerQueryFetcher {
  // `app()` resolves through the kernel's AsyncLocalStorage. The factory runs
  // inside it (request handling always does), but a render-discovered query
  // fires from React's streaming render, which the http server drives
  // *outside* the kernel scope — so capture the store now and re-enter it
  // around every fetch.
  const kernelStore = kernelContext.getStore();
  return (patternPath, params, searchParams) => {
    const origin = new URL(req.url).origin;
    const pathnameWithSearch = [applyParams(patternPath, params), searchParams.toString()]
      .filter((s) => s.length > 0)
      .join("?");
    const newReq = new Request(`${origin}/${pathnameWithSearch}`, {
      headers: req.headers,
    });
    const httpRequest = new HttpRequest(newReq, params);
    return kernelContext.run(kernelStore, () =>
      RequestContext.run(httpRequest, async () => {
        try {
          const data = await app(ApiRouteDispatcher).getRouteData(patternPath);
          // A handler that broke (`RequestBreakerError`) comes back as an
          // error `Response`, not a throw. Surface it as the same
          // `QueryError` the browser's fetch would produce — otherwise the
          // entry "resolves" and the view renders with a Response object for
          // data.
          if (data instanceof Response) {
            const body = await data.json().catch(() => null);
            if (!data.ok) {
              throw new QueryError(
                applyParams(patternPath, params),
                searchParams.toString(),
                data.status,
                body,
              );
            }
            return body;
          }
          return data;
        } catch (err) {
          if (err instanceof QueryError) throw err;
          // A raw throw inside the api handler (not a `RequestBreakerError`)
          // would otherwise leave this boundary unwrapped, so `onRequestFail`
          // would see an error with no path/variant/status attached — the
          // browser's fetch for the same failure produces a 500 `QueryError`.
          // Wrapping here keeps the two paths interchangeable and keeps the
          // error identity stable for the router's rethrow dedupe
          // (`Query.instant` rethrows the entry's — now wrapped — error).
          const wrapped = new QueryError(
            applyParams(patternPath, params),
            searchParams.toString(),
            500,
            { message: err instanceof Error ? err.message : String(err) },
          );
          wrapped.cause = err;
          throw wrapped;
        }
      }),
    );
  };
}
