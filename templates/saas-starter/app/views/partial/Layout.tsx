import { useQuery } from "gemi/client";
import type { ReactNode } from "react";
import { DemoNav, Panel, type Stamp } from "./components/Panel";

export default function PartialDemoLayout(props: { children: ReactNode; stamp?: Stamp }) {
  // Prefetched by this layout's handler. With partial rendering the prefetch
  // happens when you enter the layout; the payload stays in the query cache as
  // you move around inside it, so no `/api` request follows a navigation.
  const { data } = useQuery("/partial-render/clock", {}, { staleTime: 60_000 });

  return (
    <div className="container mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Partial rendering</h1>
      <p className="mt-2 text-slate-600">
        Each box is one route segment. The run number comes from its handler, so a number that
        does not move is a handler that did not run — its props were carried forward from the
        route you came from. Watch the Network panel too: a navigation sends one{" "}
        <code className="font-mono">.json</code> request carrying an{" "}
        <code className="font-mono">x-gemi-from</code> header, and the response says which
        segments it skipped.
      </p>

      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>Overview ⇄ Reports, or General ⇄ Billing: the layouts above hold their numbers.</li>
        <li>Switch org: the layout re-runs — its resolved path changed.</li>
        <li>Add ?tab=2: everything re-runs, handlers may read the query string.</li>
        <li>Leave and come back, or reload: everything re-runs.</li>
      </ul>

      <div className="mt-6">
        <DemoNav />
      </div>

      <div className="mt-6 space-y-4">
        <Panel stamp={props.stamp} kind="layout">
          <p className="font-mono text-sm text-slate-600">
            layout-prefetched query · clock: {data?.at ?? "…"}
          </p>
          <div className="mt-4 space-y-4">{props.children}</div>
        </Panel>
      </div>
    </div>
  );
}
