import { Panel, type Stamp } from "./components/Panel";

export default function PartialDemoAlwaysOne(props: { stamp?: Stamp }) {
  return <Panel stamp={props.stamp} kind="view" />;
}
