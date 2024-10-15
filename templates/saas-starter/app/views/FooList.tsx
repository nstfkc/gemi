import { useQuery } from "gemi/client";

export default function FooList() {
  const { data: item } = useQuery("/foo/:id", { params: { id: "Enes" } });
  console.log({ item });
  return <div>Foo list</div>;
}
