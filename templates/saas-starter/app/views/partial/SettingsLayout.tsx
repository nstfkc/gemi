import type { ReactNode } from "react";
import { Panel, type Stamp } from "./components/Panel";

export default function PartialDemoSettingsLayout(props: {
  children: ReactNode;
  stamp?: Stamp;
}) {
  return (
    <Panel stamp={props.stamp} kind="layout">
      <div className="space-y-4">{props.children}</div>
    </Panel>
  );
}
