import type { ViewProps } from "gemi/client";

export default function Test(props: ViewProps<"/:testId">) {
  return <div>TestId: {props.testId}</div>;
}
