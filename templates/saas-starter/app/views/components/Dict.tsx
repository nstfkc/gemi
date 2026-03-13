import {
  createContext,
  Suspense,
  use,
  useState,
  cache,
  type ReactNode,
} from "react";

const Ctx = createContext({});

async function fetchDict(id: string) {
  if (import.meta.env.SSR) {
    const { server } = await import("./server");
    server();
    return {
      hello: "world",
      foo: "bar",
    };
  } else {
    const res = await fetch(`/api/dict/${id}`);
    if (!res.ok) {
      throw new Error("Failed to fetch dict");
    }
    return res.json();
  }
}

const Wrapper = (props: { children: ReactNode; promise: Promise<any> }) => {
  const v = null;
  const value = v ?? use(props.promise);
  return <Ctx.Provider value={{ value }}>{props.children}</Ctx.Provider>;
};

export const Dict = (props: { id: string; children: ReactNode }) => {
  const { children, id } = props;
  return (
    <Suspense>
      <Wrapper promise={fetchDict(id)}>{children}</Wrapper>
    </Suspense>
  );
};
