import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <div className="h-dvh">
      <div>
        <button onClick={() => setCount((c) => c + 1)}>Count:{count}</button>
      </div>
      <h1>Home</h1>
    </div>
  );
}
