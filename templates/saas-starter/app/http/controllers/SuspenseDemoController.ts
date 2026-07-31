import { Controller, RequestBreakerError } from "gemi/http";
import { Query } from "gemi/facades";

/** A clean JSON error response — what `useQuery` wraps into a `QueryError`. */
class FlakyError extends RequestBreakerError {
  constructor(message: string) {
    super(message);
    this.payload = {
      api: { status: 503, data: { message } },
      view: {},
    };
  }
}

/**
 * Backs the `/suspense` demo — a hand-testable surface for suspense-ready
 * `useQuery`: a query with no cached data suspends its route segment, and
 * data that is already there (server prefetch, Link prefetch, the cache)
 * renders immediately.
 *
 * Every endpooint here is artificially slow so the behaviors are visible, and
 * each carries a per-endpoint call counter (it resets with the server) so you
 * can see when an endpoint was actually hit — by a server-side prefetch or by
 * the browser going to `/api`.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = new Map<string, number>();

function call<T extends Record<string, unknown>>(endpoint: string, extra: T) {
  const count = (calls.get(endpoint) ?? 0) + 1;
  calls.set(endpoint, count);
  return {
    endpoint,
    call: count,
    at: new Date().toISOString().slice(11, 23),
    ...extra,
  };
}

export class SuspenseDemoController extends Controller {
  // ---------------------------------------------------------------- views

  layout() {
    return { title: "Suspense" };
  }

  instant() {
    // Prefetched on the server: the page ships with the data already in the
    // HTML and in the client cache — the two `useQuery("/suspense-demo/products")`
    // below it never suspend and never hit `/api`, despite the endpoint's
    // 600ms delay. The cost lives here: SSR waits for the prefetch queue.
    Query.prefetch("/suspense-demo/products");
    return { title: "Instant" };
  }

  slow() {
    // Deliberately NOT prefetched — this is the page that demonstrates
    // suspension. Navigating here keeps the previous page on screen (watch
    // the nav link dim via `data-pending`) until `/suspense-demo/metrics`
    // resolves. Hard-loading it logs the server warning naming the missing
    // `Query.prefetch`, ships the HTML without the data, and the client
    // suspends into the view's `Loading` export after hydration.
    return { title: "Slow" };
  }

  broken() {
    return { title: "Broken" };
  }

  // ---------------------------------------------------------------- api

  async products() {
    await sleep(600);
    return call("/suspense-demo/products", {
      products: [
        { id: 1, name: "Synapse", price: "$19" },
        { id: 2, name: "Cortex", price: "$49" },
        { id: 3, name: "Lobe", price: "$99" },
      ],
    });
  }

  async metrics() {
    await sleep(1200);
    return call("/suspense-demo/metrics", {
      metrics: [
        { label: "Signups", value: 412 },
        { label: "Active", value: 187 },
        { label: "Churn", value: "2.4%" },
      ],
    });
  }

  /**
   * Fails twice, succeeds on the third call — so the segment's `Error`
   * export renders first, and its retry button eventually lands the data.
   */
  async flaky() {
    await sleep(400);
    const count = (calls.get("/suspense-demo/flaky") ?? 0) + 1;
    if (count % 3 !== 0) {
      calls.set("/suspense-demo/flaky", count);
      throw new FlakyError(`Failing on purpose — attempt ${count}, every 3rd one succeeds.`);
    }
    return call("/suspense-demo/flaky", {
      secret: "Third time's the charm.",
    });
  }
}
