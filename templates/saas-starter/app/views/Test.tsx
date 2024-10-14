import { useMutation, useParams, useQuery, type ViewProps } from "gemi/client";

export default function Test(props: ViewProps<"/:testId">) {
  const { data, loading } = useQuery("/test/:testId", {
    params: { testId: "Enes 3218!" },
  });

  const {} = useQuery("/foo/:id");

  return (
    <div>
      <h1 className="text-2xl font-bold text-green-900">Test</h1>
      <div>{loading ? "Loading..." : data}</div>
    </div>
  );
}
