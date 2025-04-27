import { useTranslator } from "gemi/client";
import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);

  const x = useTranslator("HomePage");

  return (
    <div className="h-dvh">
      <div>
        <div>Title: {x("title", { version: "1" })}</div>
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          Count:{count}
        </button>
      </div>
      <h1>Home</h1>
    </div>
  );
}
