import {
  useMutation,
  useParams,
  useQuery,
  useSubscription,
  type ViewProps,
} from "gemi/client";
import { useEffect, useState } from "react";

export default function Test(props: ViewProps<"/:testId">) {
  const { data, loading } = useQuery("/test/:testId", {
    params: { testId: "Enes 3218!" },
  });

  const [items, setItems] = useState<string[]>([]);

  useSubscription("/logs/live", {
    params: {},
    cb: (data) => {
      console.log(data);
      setItems((prev) => [...prev, data]);
    },
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-green-900">Test</h1>
      <div>
        {items.map((item, index) => (
          <div key={index}>{JSON.stringify(item)}</div>
        ))}
      </div>
      <div>{loading ? "Loading..." : data}</div>
    </div>
  );
}
