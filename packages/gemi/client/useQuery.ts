import { useEffect, useState } from "react";
import { QueryInput } from "./rpc";

export function useQuery<T extends keyof QueryInput>(
  url: T,
  params: QueryInput[T],
) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function execute() {
      setLoading(true);
      try {
        const res = await fetch(`/api${url}`);
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }
      } catch (err) {
        setError(JSON.stringify(err));
      } finally {
        setLoading(false);
      }

      execute();
    }
  }, [url]);

  return { data, loading, error };
}
