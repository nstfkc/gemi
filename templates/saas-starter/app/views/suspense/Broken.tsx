import { useQuery, type QueryError } from "gemi/client";

/**
 * The endpoint fails twice and succeeds on the third call. The failure throws
 * a `QueryError` into this segment's error boundary, which renders the
 * `Error` export below; its retry button resets the boundary, which clears
 * the stored error and re-runs the query.
 */
export default function SuspenseDemoBroken() {
  const { data } = useQuery("/suspense-demo/flaky");

  return (
    <section className="rounded-lg border border-emerald-300 bg-emerald-50/50 p-4">
      <h2 className="font-semibold">It worked</h2>
      <p className="mt-2 text-sm">{data.secret}</p>
      <p className="mt-3 font-mono text-xs text-slate-500">
        call #{data.call} · {data.at}
      </p>
    </section>
  );
}

/** The segment's error UI — receives react-error-boundary's FallbackProps. */
export function Error(props: { error: QueryError; resetErrorBoundary: () => void }) {
  const { error, resetErrorBoundary } = props;

  return (
    <section role="alert" className="rounded-lg border border-red-300 bg-red-50/60 p-4">
      <h2 className="font-semibold text-red-800">The query failed</h2>
      <p className="mt-2 font-mono text-sm text-red-700">
        {error.status ? `${error.status} — ` : ""}
        {error.message}
      </p>
      <button
        type="button"
        className="mt-4 rounded border border-red-300 bg-white px-3 py-1 text-sm"
        onClick={() => resetErrorBoundary()}
      >
        Try again
      </button>
    </section>
  );
}
