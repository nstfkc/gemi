import {
  Form,
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
import { useEffect, useState } from "react";

export default function Home(props: ViewProps<"/">) {
  const searchParams = useSearchParams();
  const { filters } = props;
  const { data = [], loading } = useQuery("/home", {
    search: { color: searchParams.get("color") },
  });

  const t = useTranslator();

  return (
    <div>
      <span>{t("greeting", { name: "Enes" })}</span>
      <div>{loading ? "Loading..." : ""}</div>
      <Form method="POST" action="/upload">
        <input type="file" name="images" multiple={true} />
        <button type="submit">Upload</button>
      </Form>
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
