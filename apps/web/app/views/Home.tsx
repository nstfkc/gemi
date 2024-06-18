import { useState } from "react";

console.log("Hello");
export function useHome() {
  return "Hello";
}

export default function Home() {
  const [state, setState] = useState("");
  return <div>{state}</div>;
}
