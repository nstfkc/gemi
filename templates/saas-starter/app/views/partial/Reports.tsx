import { useQuery } from "gemi/client";
import { useState } from "react";
import { Panel, QueryRow, type Stamp } from "./components/Panel";

export default function PartialDemoReports(props: { stamp?: Stamp; page?: string }) {
  // The page this view's handler prefetched. Paging is local state, so switching
  // it does not navigate — the query just asks for a variant nobody prefetched,
  // and that one has to come over `/api`.
  const prefetchedPage = props.page ?? "1";
  const [page, setPage] = useState(prefetchedPage);

  const reports = useQuery(
    "/partial-render/reports",
    { search: { page } },
    { staleTime: Number.POSITIVE_INFINITY },
  );

  return (
    <Panel stamp={props.stamp} kind="view">
      <QueryRow
        prefetchedBy={page === prefetchedPage ? "this view" : null}
        state={reports}
      />
      <div className="mt-3 flex items-center gap-2">
        {["1", "2", "3"].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setPage(n)}
            className={[
              "rounded border px-2 py-1 text-sm",
              n === page ? "border-slate-800 bg-slate-800 text-white" : "border-slate-300 bg-white",
            ].join(" ")}
          >
            page {n}
          </button>
        ))}
        <span className="text-xs text-slate-500">
          page {prefetchedPage} was prefetched on the server; the others are not
        </span>
      </div>
    </Panel>
  );
}
