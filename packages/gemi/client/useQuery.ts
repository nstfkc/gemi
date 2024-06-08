import { useEffect, useState } from "react";

export function useQuery(url: string) {
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
