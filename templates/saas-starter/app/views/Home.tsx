import { Link, usePost, usePut, useQuery } from "gemi/client";

export default function Home() {
  const {} = usePut("/orders/:orderId");
  return (
    <div>
      <div>
        <h1>Home</h1>
      </div>
      <div>
        <Link href="/about">About</Link>
      </div>
    </div>
  );
}
