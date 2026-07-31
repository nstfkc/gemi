import { Link, useRouteTransition } from "gemi/client";
import type { ReactNode } from "react";

/**
 * The `/suspense` demo — suspense-ready `useQuery` in one place.
 *
 * A query with no cached data suspends its route segment; data that is
 * already there (server `Query.prefetch`, a `<Link prefetch>` payload, the
 * cache) renders immediately. Each page below demonstrates one consequence.
 */
export default function SuspenseDemoLayout(props: { children: ReactNode; title?: string }) {
  const { isTransitioning } = useRouteTransition();

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Suspense</h1>
      <p className="mt-2 text-slate-600">
        Every endpoint here is artificially slow, and every row shows a{" "}
        <strong>call #</strong> from its API handler — a number that does not
        move is a request that did not happen. Watch the nav links: a dimmed
        link is a navigation in flight while the previous page stays on screen.
      </p>

      <nav className="mt-6 flex items-center gap-3 border-b border-slate-200 pb-3 text-sm">
        <Link className={demoLink} href="/suspense">
          Instant (prefetched)
        </Link>
        <Link className={demoLink} href="/suspense/slow">
          Slow (suspends)
        </Link>
        <Link className={demoLink} href="/suspense/broken">
          Broken (error boundary)
        </Link>
        <span
          aria-hidden
          className={[
            "ml-auto h-2 w-2 rounded-full transition-opacity",
            isTransitioning ? "bg-amber-500 opacity-100" : "bg-emerald-500 opacity-40",
          ].join(" ")}
          title={isTransitioning ? "navigation pending" : "idle"}
        />
      </nav>

      <div className="mt-6">{props.children}</div>
    </div>
  );
}

const demoLink = [
  "rounded px-2 py-1",
  "data-[active=true]:bg-slate-800 data-[active=true]:text-white",
  // The whole point: while the next page's queries resolve, the link you
  // clicked dims and the page you are on stays put.
  "data-[pending=true]:animate-pulse data-[pending=true]:opacity-50",
].join(" ");
