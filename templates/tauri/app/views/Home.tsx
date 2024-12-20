import { useQuery } from "gemi/client";
import { useEffect } from "react";

export default function Home() {
  const { data } = useQuery("/home");
  console.log({ data });
  return <div>Home</div>;
}
