import type { ViewProps } from "gemi/client";

export default function Pricing(props: ViewProps<"/pricing">) {
  return (
    <div className="h-dvh">
      <h1>{props.title}</h1>
      <div>{props.time}</div>
    </div>
  );
}
