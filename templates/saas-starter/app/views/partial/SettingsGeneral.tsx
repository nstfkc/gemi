import { useQuery } from "gemi/client";
import { Panel, QueryRow, type Stamp } from "./components/Panel";

export default function PartialDemoSettingsGeneral(props: { stamp?: Stamp }) {
  // Two layouts up the tree prefetched this, and it is still a cache read here.
  const org = useQuery("/partial-render/org/:orgId", {}, { staleTime: Number.POSITIVE_INFINITY });

  return (
    <Panel stamp={props.stamp} kind="view">
      <QueryRow prefetchedBy="the outer layout" state={org} />
    </Panel>
  );
}
