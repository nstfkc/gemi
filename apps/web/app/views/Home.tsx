import { Link } from "gemi/client";
import { useState } from "react";

export default function Home(props: { count: number }) {
  const [count, setCount] = useState(props.count);
  return (
    <div className="py-4">
      <div>
        <h1 className="font-bold text-4xl">Gemi</h1>
        <Link href="/about">About</Link>
      </div>
    </div>
  );
}
