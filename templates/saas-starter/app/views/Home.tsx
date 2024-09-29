import {
  Form,
  Link,
  useDelete,
  useMutation,
  usePatch,
  usePost,
  useQuery,
  useSearchParams,
  useSubscription,
  useUser,
  type ViewProps,
} from "gemi/client";
import { useEffect, useState } from "react";

export default function Home(props: ViewProps<"/">) {
  const searchParams = useSearchParams();
  const { filters } = props;
  const [id, setId] = useState(0);
  const { data = [], loading } = useQuery("/home", {
    search: { color: searchParams.get("color") },
  });

  return (
    <div>
      <div>{loading ? "Loading..." : ""}</div>
      <div className="flex gap-2">
        {filters.map((filter) => {
          return (
            <div key={filter}>
              <button onClick={() => searchParams.set("color", filter).push()}>
                {filter}
              </button>
            </div>
          );
        })}
      </div>
      <div>
        {data.map((item) => {
          return (
            <div key={item.id}>
              <div
                style={{
                  backgroundColor: item.color,
                  width: "32px",
                  height: "32px",
                }}
              ></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
