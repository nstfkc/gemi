import { useQuery } from "gemi/client";
import type { ReactNode } from "react";
import { DemoNav, Panel, QueryRow, type Stamp } from "./components/Panel";

export default function PartialDemoLayout(props: { children: ReactNode; stamp?: Stamp }) {
  // Prefetched by this layout's handler, with this route's `:orgId` — `useQuery`
  // fills the param in from `useParams()`, exactly as the handler did.
  const org = useQuery("/partial-render/org/:orgId", {}, { staleTime: Number.POSITIVE_INFINITY });

  // Nobody prefetches this one, so the browser fetches it over `/api` the first
  // time this layout mounts. It then stays in the cache — and because a carried
  // layout does not re-mount, navigating around inside it does not refetch it.
  const notifications = useQuery(
    "/partial-render/notifications",
    {},
    { staleTime: Number.POSITIVE_INFINITY },
  );

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Partial rendering</h1>
      <p className="mt-2 text-slate-600">
        Each box is one route segment. <strong>run #</strong> comes from its view handler and{" "}
        <strong>call #</strong> from an API handler, so a number that does not move is work that
        did not happen. A navigation sends one <code className="font-mono">.json</code> request
        carrying an <code className="font-mono">x-gemi-from</code> header, and the response says
        which segments it skipped.
      </p>

      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>
          Overview ⇄ Reports, or General ⇄ Billing: the layouts hold their run numbers, and so
          does the org endpoint they prefetched — no <code className="font-mono">/api</code>{" "}
          request goes out for it.
        </li>
        <li>
          Reports prefetches its own data, and a view always runs — so its call number moves every
          time you enter it. Its in-page pager asks for a page the handler did not prefetch, which
          is the one thing here that does reach <code className="font-mono">/api</code>.
        </li>
        <li>Switch org: the layout re-runs, so its prefetch runs again with the new param.</li>
        <li>Add ?tab=2: everything re-runs — handlers may read the query string.</li>
        <li>Leave and come back, or reload: everything re-runs.</li>
      </ul>

      <div className="mt-6">
        <DemoNav />
      </div>

      <div className="mt-6">
        <Panel stamp={props.stamp} kind="layout">
          <QueryRow prefetchedBy="this layout" state={org} />
          <QueryRow prefetchedBy={null} state={notifications} />
          <div className="mt-4 space-y-4">{props.children}</div>
        </Panel>
      </div>
    </div>
  );
}
