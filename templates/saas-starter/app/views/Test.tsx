import { useParams, useQuery, type ViewProps } from "gemi/client";

export default function Test(props: ViewProps<"/:testId">) {
  const { testId } = useParams();
  const { data, loading } = useQuery("/test/:id", { params: { id: testId } });

  return (
    <div>
      <h1 className="text-2xl font-bold text-green-900">Test</h1>
      <div>{loading ? "Loading..." : data}</div>
    </div>
  );
}
