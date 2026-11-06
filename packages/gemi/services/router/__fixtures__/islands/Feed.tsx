import { useState } from "react";
import { useQuery } from "../../../../client/useQuery";

/**
 * Islands for the island-query tests (#1155): one reads a list under
 * suspense (with a search when given a tag), one reads a count without
 * suspending.
 */

type Post = { id: number; title: string };

/** A list of posts the page prefetched, with a counter so hydration is visible. */
export default function Feed(props: { tag?: string }) {
  const { data } = useQuery("/posts" as any, props.tag ? { search: { tag: props.tag } } : {});
  const [n, setN] = useState(0);
  return (
    <section className="feed">
      <ul>
        {((data as Post[] | undefined) ?? []).map((post) => (
          <li key={post.id}>{post.title}</li>
        ))}
      </ul>
      <button type="button" onClick={() => setN(n + 1)}>
        {n}
      </button>
    </section>
  );
}

/** Reads the cache without suspending: what it renders is what is cached. */
export function Count(props: { of?: string }) {
  const { data } = useQuery("/count" as any, props.of ? { search: { of: props.of } } : {}, { suspense: false });
  return <output>{(data as { n: number } | undefined)?.n ?? "…"}</output>;
}

export function PlainCounter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" className="plain" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}
