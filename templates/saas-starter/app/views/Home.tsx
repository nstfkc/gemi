import { useQuery, type LayoutProps, type ViewProps } from "gemi/client";

export default function Home(props: ViewProps<"/">) {
  return (
    <div>
      <h1>Home</h1>
      <div>{props.message}</div>
    </div>
  );
}
