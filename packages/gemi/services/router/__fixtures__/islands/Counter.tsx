import { type ReactNode, useId, useState } from "react";

/**
 * An island component for the island tests: state, `useId` and static
 * children, the three things hydration has to get right.
 */
export default function Counter(props: { start: number; label: string; children?: ReactNode }) {
  const [count, setCount] = useState(props.start);
  const id = useId();
  return (
    <div className="counter">
      <label htmlFor={id}>{props.label}</label>
      <output id={id}>{count}</output>
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        +1
      </button>
      {props.children}
    </div>
  );
}

export function Greeting(props: { name: string }) {
  return <p>Hello, {props.name}</p>;
}
