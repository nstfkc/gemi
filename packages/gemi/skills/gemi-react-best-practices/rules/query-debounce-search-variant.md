---
title: Debounce a Value Before It Becomes a Query Variant
impact: MEDIUM-HIGH
impactDescription: one request per pause instead of per keystroke
tags: query, debounce, search, effects
---

## Debounce a Value Before It Becomes a Query Variant

Every distinct `search` object is a distinct cache key, so feeding raw input state
straight into `useQuery` fires a request per keystroke and fills the cache with
entries nobody will read again.

Debounce with a debounce hook — **not** a hand-rolled
`useEffect` + `setTimeout`. The house rule in most gemi apps is that data flow does
not go
through effects: derive in `useMemo`, reset in the change handler, debounce with the
hook (`rerender-no-effect-data-flow`).

**Incorrect (a request per keystroke, and a hand-rolled timer to boot):**

```tsx
const [query, setQuery] = useState("");
const [debounced, setDebounced] = useState("");

useEffect(() => {
  const id = setTimeout(() => setDebounced(query), 250);
  return () => clearTimeout(id);
}, [query]);
```

**Correct:**

```tsx
// A debounce hook — your own, or one from a library.
import { useDebounceValue } from "@/app/hooks/useDebounceValue";

const [query, setQuery] = useState("");
const [debouncedQuery] = useDebounceValue(query.trim(), 250);

const { data = [], loading } = useQuery(
  "/app/:orgId/products/search",
  { params: { orgId }, search: { q: debouncedQuery || null, limit } },
  { suspense: false },
);
```

Two details worth copying from the call sites above:

- **`.trim()` before debouncing**, so trailing whitespace is not its own variant.
- **`|| null` rather than `""`** — pick one empty representation and use it
  everywhere, or the empty-search variant splits in two.
