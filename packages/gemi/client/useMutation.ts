import { useState } from "react";

export function useMutation(
  url: string,
  options: { method: string } = { method: "POST" },
) {
  const { method } = options;
  const [isPending, setIsPending] = useState(false);
  const [data, setData] = useState(null);
  return {
    data,
    isPending,
    trigger: async (args?: any) => {
      setIsPending(true);
      // TODO: Add error handling
      const response = await fetch(`/api${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        ...(args ? { body: JSON.stringify(args) } : {}),
      });

      const data = await response.json();
      setData(data);
      setIsPending(false);
      return data;
    },
  };
}
