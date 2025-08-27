import type { Account, Organization, User } from "@prisma/client";
import {
  Form,
  Link,
  useFormData,
  useLocation,
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
  const { trigger, progress } = useUpload("/upload");
  return (
    <div>
      <h1>Home</h1>
      <div>
        <input
          name="file"
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              trigger(file);
            }
          }}
        />
        <div>Progress: {Math.ceil(progress * 100)}</div>
      </div>
    </div>
  );
}
