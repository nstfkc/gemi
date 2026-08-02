import { Link, useParams } from "gemi/client";
import type { ReactNode } from "react";

/** What every handler in the demo returns, via `PartialRenderController`. */
export type Stamp = {
  segment: string;
  run: number;
  at: string;
};

/**
 * One route segment. `stamp` is whatever its handler returned the last time it
 * ran — so if the number does not move when you navigate, that handler did not
 * run and its props were carried forward from the route you came from.
 */
export function Panel(props: { stamp?: Stamp; kind: "layout" | "view"; children?: ReactNode }) {
  const { stamp, kind, children } = props;
  const isLayout = kind === "layout";

  return (
    <section
      className={[
        "rounded-lg border p-4",
        isLayout ? "border-emerald-300 bg-emerald-50/50" : "border-slate-300 bg-white",
      ].join(" ")}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">
          {stamp?.segment ?? "unknown"}
          <span className="ml-2 text-xs font-normal uppercase tracking-wide text-slate-500">
            {kind}
          </span>
        </h2>
        <p className="font-mono text-sm">
          {stamp ? (
            <>
              run #{stamp.run} · {stamp.at}
            </>
          ) : (
            // The handler was skipped *and* nothing carried its props over —
            // if you ever see this, the merge on the client is broken.
            <span className="text-red-600">no props</span>
          )}
        </p>
      </header>
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}

/** What every endpoint in the demo returns, via `PartialRenderController`. */
export type Call = {
  endpoint: string;
  call: number;
  at: string;
};

/**
 * One `useQuery` read. `call #N` is the endpoint's own counter, so the number
 * only moves when the endpoint was actually hit — by a server-side prefetch or
 * by the browser going to `/api`.
 */
export function QueryRow(props: {
  prefetchedBy: string | null;
  state: { data?: Call; loading: boolean };
}) {
  const { prefetchedBy, state } = props;

  return (
    <p className="font-mono text-sm text-slate-700">
      <span className={prefetchedBy ? "text-emerald-700" : "text-amber-700"}>
        {prefetchedBy ? `prefetched by ${prefetchedBy}` : "not prefetched"}
      </span>
      {" · "}
      {state.loading && !state.data ? (
        "loading…"
      ) : state.data ? (
        <>
          {state.data.endpoint} → call #{state.data.call} · {state.data.at}
        </>
      ) : (
        "—"
      )}
    </p>
  );
}

export function DemoNav() {
  const { orgId = "acme" } = useParams() as { orgId?: string };
  const other = orgId === "acme" ? "globex" : "acme";

  const linkClass =
    "rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100 data-[pending=true]:opacity-50";

  return (
    <nav className="flex flex-wrap gap-2">
      <Link className={linkClass} href="/partial/:orgId" params={{ orgId }}>
        Overview
      </Link>
      <Link className={linkClass} href="/partial/:orgId/reports" params={{ orgId }}>
        Reports
      </Link>
      <Link className={linkClass} href="/partial/:orgId/settings/general" params={{ orgId }}>
        Settings → General
      </Link>
      <Link className={linkClass} href="/partial/:orgId/settings/billing" params={{ orgId }}>
        Settings → Billing
      </Link>
      <Link className={linkClass} href="/partial/:orgId/reports" params={{ orgId }} search={{ tab: "2" }}>
        Reports ?tab=2
      </Link>
      <Link className={linkClass} href="/partial/:orgId" params={{ orgId: other }}>
        Switch org → {other}
      </Link>
      <Link className={linkClass} href="/partial/always/:orgId/one" params={{ orgId }}>
        alwaysRun() demo
      </Link>
      <Link className={linkClass} href="/about">
        Leave the layout
      </Link>
    </nav>
  );
}
