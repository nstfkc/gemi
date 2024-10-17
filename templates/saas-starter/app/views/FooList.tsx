import { usePost, useQuery } from "gemi/client";

export default function FooList() {
  const { data } = useQuery("/foo-bar-baz/:fooBarBazId", {
    params: { fooBarBazId: "1234" },
  });

  return (
    <div>
      <h1>{data.id}</h1>
    </div>
  );
}
