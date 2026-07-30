import { Controller } from "gemi/http";
import { Query } from "gemi/facades";
import type { HttpRequest } from "gemi/http";

/**
 * Backs the `/partial` demo — a hand-testable surface for gemi's partial
 * rendering, where a navigation only re-runs the route segments that actually
 * changed, and for what that means for `Query.prefetch` + `useQuery`.
 *
 * Two counters, both living in the server process (they reset when it restarts):
 *
 *   - `stamp()` — one shared, ever-increasing run number across all *view*
 *     handlers, so the page shows which segments ran for the navigation you
 *     just made.
 *   - `call()` — a per-endpoint counter for the *API* handlers, so you can see
 *     when an endpoint is actually hit, whether by a server-side prefetch or by
 *     the browser going to `/api`.
 */
let runs = 0;

function stamp(segment: string) {
  runs += 1;
  return {
    segment,
    run: runs,
    at: new Date().toISOString().slice(11, 23),
  };
}

const calls = new Map<string, number>();

function call(endpoint: string, extra: Record<string, unknown> = {}) {
  const count = (calls.get(endpoint) ?? 0) + 1;
  calls.set(endpoint, count);
  return {
    endpoint,
    call: count,
    at: new Date().toISOString().slice(11, 23),
    ...extra,
  };
}

export class PartialRenderController extends Controller {
  // ---------------------------------------------------------------- views

  layout(req: HttpRequest<any, { orgId: string }>) {
    // Prefetched by the *layout*, so it is fetched when you enter the layout
    // and not again as you move around inside it. Two segments below read it
    // with `useQuery` and neither goes to `/api` for it.
    Query.prefetch("/partial-render/org/:orgId", {
      params: { orgId: req.params.orgId },
    });
    return { stamp: stamp("Layout") };
  }

  overview() {
    return { stamp: stamp("Overview") };
  }

  reports(req: HttpRequest<any, any>) {
    // Prefetched by a *view*, and a view always runs — so this one is fetched
    // on every navigation into Reports. Note the search key: only the page the
    // handler asked for lands in the cache.
    const page = String(req.search.get("page") ?? "1");
    Query.prefetch("/partial-render/reports", { search: { page } });
    return { stamp: stamp("Reports"), page };
  }

  settingsLayout() {
    return { stamp: stamp("SettingsLayout") };
  }

  settingsGeneral() {
    return { stamp: stamp("Settings → General") };
  }

  settingsBilling() {
    return { stamp: stamp("Settings → Billing") };
  }

  alwaysLayout() {
    return { stamp: stamp("AlwaysLayout") };
  }

  alwaysOne() {
    return { stamp: stamp("Always → One") };
  }

  alwaysTwo() {
    return { stamp: stamp("Always → Two") };
  }

  // ------------------------------------------------------------- endpoints

  /** Prefetched by the layout, with the route's own `:orgId`. */
  org(req: HttpRequest<any, { orgId: string }>) {
    return call(`/org/${req.params.orgId}`, { orgId: req.params.orgId });
  }

  /** Prefetched by the Reports view, one variant per page. */
  reportsData(req: HttpRequest<any, any>) {
    const page = String(req.search.get("page") ?? "1");
    return call(`/reports?page=${page}`, { page });
  }

  /** Prefetched by nobody — the contrast case, fetched by the browser. */
  notifications() {
    return call("/notifications", { unread: Math.ceil(Math.random() * 9) });
  }
}
