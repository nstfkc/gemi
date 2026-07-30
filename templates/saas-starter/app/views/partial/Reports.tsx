import { useQuery } from "gemi/client";
import { Panel, type Stamp } from "./components/Panel";

export default function PartialDemoReports(props: { stamp?: Stamp }) {
  // The same endpoint the layout prefetched. This view mounts *after* the
  // navigation has landed, and still reads it from cache.
  const { data, loading } = useQuery("/partial-render/clock", {}, { staleTime: 60_000 });

  return (
    <Panel stamp={props.stamp} kind="view">
      <p className="font-mono text-sm text-slate-600">
        same query, read from cache · clock: {loading ? "loading…" : (data?.at ?? "—")}
      </p>
    </Panel>
  );
}
