import { useQuery, useMutation } from "gemi/client";
import type { ComponentProps } from "react";

export default function Home() {
  const { data } = useQuery("GET:/health-check");
  const { data } = useMutation("POST:/test/all/nested", {
    input: { id: "hey" },
    params: {},
  });
  return (
    <div className="py-4">
      <div className="py-8">
        Update <code>/app/views/Home.tsx to update this page</code>
      </div>
    </div>
  );
}
