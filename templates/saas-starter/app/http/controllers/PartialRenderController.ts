import { Controller } from "gemi/http";
import { Query } from "gemi/facades";

/**
 * Backs the `/partial` demo — a hand-testable surface for gemi's partial
 * rendering, where a navigation only re-runs the route segments that actually
 * changed.
 *
 * Every handler stamps itself with a shared, ever-increasing run number, so the
 * page shows at a glance which handlers ran for the navigation you just made.
 * The counter lives in the server process and resets when it restarts.
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

export class PartialRenderController extends Controller {
  layout() {
    // Prefetched by the *layout*, so with partial rendering it is fetched when
    // you enter the layout and not again as you move around inside it. The
    // views below read it with `useQuery` and should never hit `/api`.
    Query.prefetch("/partial-render/clock");
    return { stamp: stamp("Layout") };
  }

  overview() {
    return { stamp: stamp("Overview") };
  }

  reports() {
    return { stamp: stamp("Reports") };
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

  /** The endpoint the layout prefetches. Its value changes on every real call. */
  clock() {
    return { at: new Date().toISOString().slice(11, 23) };
  }
}
