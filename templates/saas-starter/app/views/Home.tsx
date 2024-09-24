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
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

export default function Home(props: ViewProps<"/">) {
  const searchParams = useSearchParams();
  const [id, setId] = useState(0);

  const { data } = useQuery("/test/:id", { params: { id } });

  return (
    <div>
      <div>Test</div>
      <div>Id: {id}</div>
      <div>Data: {data}</div>
      <div>
        <button onClick={() => setId((id) => id + 1)}>Update id</button>
      </div>
    </div>
  );
}
