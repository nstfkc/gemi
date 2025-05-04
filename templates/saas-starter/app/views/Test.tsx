import { useLocale, useQuery, type ViewProps } from "gemi/client";

export default function Test(props: ViewProps<"/test/:testId">) {
  return <div>{props.message}</div>;
}
