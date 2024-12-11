import {
  Form,
  Image,
  Link,
  useDelete,
  useMutation,
  usePatch,
  usePost,
  usePut,
  useQuery,
  useSearchParams,
  useSubscription,
  useTranslator,
  useUser,
  type ViewProps,
} from "gemi/client";

import { useEffect, useState, lazy } from "react";
import { Carousel } from "./components/Carousel";

export default function Home(props: ViewProps<"/">) {
  const searchParams = useSearchParams();
  const { filters } = props;
  const { data = [], loading } = useQuery("/home", {
    search: { color: searchParams.get("color") },
  });

  const t = useTranslator();

  return (
    <div>
      <Image
        src="/api/image/007bd6e5-b10c-4f5c-95cc-2e68485caa37.webp"
        width={200}
      />
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

        <div>
          <button onClick={() => searchParams.set("color", "indigo").push()}>
            Indigo
          </button>
        </div>
        <div>
          <button onClick={() => searchParams.delete("color").push()}>
            Clear
          </button>
        </div>
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
