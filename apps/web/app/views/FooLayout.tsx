import type { ReactNode } from "react";

export default function FooLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <h1>Foo Layout</h1>
      {children}
    </div>
  );
}
