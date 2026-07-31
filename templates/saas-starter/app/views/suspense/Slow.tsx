import { useQuery } from "gemi/client";

/**
 * Deliberately NOT prefetched — this is the page that suspends.
 *
 * - Navigate here from another demo page: the page you were on stays visible
 *   (the nav link dims) until the 1.2s endpoint resolves, then this commits.
 * - Hard-load it: the server logs a warning naming the missing
 *   `Query.prefetch("/suspense-demo/metrics")`, ships the HTML without the
 *   data, and the client suspends into the `Loading` export below after
 *   hydration.
 */
export default function SuspenseDemoSlow() {
  const { data, refetch } = useQuery("/suspense-demo/metrics");

  return (
    <div>
      <p className="text-sm text-slate-600">
        Nothing prefetches this query, and the endpoint takes 1.2s. You either
        waited on the page you came from (client navigation) or watched the
        skeleton below (hard load).
      </p>
      <section className="mt-4 rounded-lg border border-slate-300 bg-white p-4">
        <header className="flex items-baseline justify-between">
          <h2 className="font-semibold">Metrics</h2>
          <button
            type="button"
            className="text-xs text-slate-500 underline"
            onClick={() => refetch()}
          >
            refetch
          </button>
        </header>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
          {data.metrics.map((metric) => (
            <div key={metric.label} className="rounded bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-500">{metric.label}</dt>
              <dd className="mt-1 font-mono text-lg">{metric.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 font-mono text-xs text-slate-500">
          call #{data.call} · {data.at}
        </p>
      </section>
    </div>
  );
}

/** The segment's Suspense fallback — used on a hard load of this route. */
export function Loading() {
  return (
    <div>
      <p className="text-sm text-slate-600">Loading metrics…</p>
      <section className="mt-4 animate-pulse rounded-lg border border-slate-200 bg-white p-4">
        <div className="h-5 w-24 rounded bg-slate-200" />
        <div className="mt-3 grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded bg-slate-100" />
          ))}
        </div>
      </section>
    </div>
  );
}
