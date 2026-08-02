import { useQuery } from "gemi/client";
import { Panel, QueryRow, type Stamp } from "./components/Panel";

export default function PartialDemoOverview(props: { stamp?: Stamp }) {
  // The layout prefetched this, not this view — and it still comes out of the
  // cache here, on a segment that mounted after the navigation landed.
  const org = useQuery("/partial-render/org/:orgId", {}, { staleTime: Number.POSITIVE_INFINITY });

  return (
    <Panel stamp={props.stamp} kind="view">
      <QueryRow prefetchedBy="the layout above" state={org} />
    </Panel>
  );
}
