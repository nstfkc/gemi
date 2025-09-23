import type { Account, Organization, User } from "@prisma/client";
import {
  Form,
  Link,
  useFormData,
  useLocation,
  useMutate,
  usePost,
  usePut,
  useQuery,
  useSearchParams,
  useTheme,
  useTranslator,
  useUpload,
  type QueryResult,
  type ViewProps,
} from "gemi/client";
import { useId, useState } from "react";

const FormData = () => {
  const formData = useFormData();
  const state = formData.getAll("test");
  console.log([
    { item: formData.get("number") },
    state,
    formData.get("text"),
    formData.get("radio"),
  ]);
  return <pre>{JSON.stringify({})}</pre>;
};

export default function Home() {
  const { data } = useQuery("/health", {}, { refreshInterval: 20000 });
  const mutate = useMutate();

  return (
    <div>
      <h1>Home</h1>
      <button
        onClick={() =>
          mutate(
            {
              //
              path: "/health",
              params: { orgId: 1 },
            },
            {
              status: "1234",
            },
          )
        }
      >
        Trigger
      </button>
      <div>{JSON.stringify(data)}</div>
    </div>
  );
}
