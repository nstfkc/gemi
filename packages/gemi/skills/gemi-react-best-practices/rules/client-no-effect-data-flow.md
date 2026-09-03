---
title: Do Not Route Data Flow Through useEffect
impact: MEDIUM
impactDescription: removes a render pass and a class of stale-state bugs
tags: rerender, effects, derived-state, house-style
---

## Do Not Route Data Flow Through useEffect

An effect that computes state runs *after* a render commits, so it costs an extra
render pass and opens a window where the UI shows a stale value. This is a standing
house rule in most gemi apps, not a preference. Three replacements cover almost
every
case:

| Instead of an effect that… | Do this |
|---|---|
| resets state when a prop or selection changes | reset in the `onChange` handler — it is event-driven |
| computes a value from other state | derive it in `useMemo` from the source |
| debounces a value | a debounce hook, applied to the value before it is used |

**Incorrect (three effects doing data flow):**

```tsx
const [selected, setSelected] = useState(null);
const [query, setQuery] = useState("");
const [debounced, setDebounced] = useState("");
const [options, setOptions] = useState([]);

useEffect(() => { setQuery(""); }, [selected]);            // reset
useEffect(() => { setOptions(items.filter(fn)); }, [items]); // derive
useEffect(() => {                                            // debounce
  const id = setTimeout(() => setDebounced(query), 250);
  return () => clearTimeout(id);
}, [query]);
```

**Correct:**

```tsx
// gemi ships no debounce hook — this is your own, or one from a library.
import { useDebounced } from "@/app/hooks/useDebounced";

const [selected, setSelected] = useState(null);
const [query, setQuery] = useState("");
const [debouncedQuery] = useDebounced(query.trim(), 250);

const options = useMemo(() => items.filter(fn), [items]);

function onSelect(next) {
  setSelected(next);
  setQuery(""); // reset where the event happens
}
```

**Whether the memoization here is load-bearing depends on your build.** If your
`gemi.config.ts` enables the React plugin's `compiler` option — the default in
projects scaffolded from the gemi template, unless `GEMI_REACT_COMPILER=off` is set —
the React Compiler memoizes the client build for you, and a hand-written `useMemo` on a derived value is mostly redundant. Without it,
`useMemo` / `useCallback` on a value that feeds a query variant, an effect dependency,
or a memoized child is doing real work, not decoration. Check the config before you
add or remove one.

Either way the *shape* above is the point: derive in `useMemo`, do not compute state
in an effect. The compiler removes the boilerplate, not the extra render pass.

Effects remain correct for actual synchronization with the outside world:
subscriptions, event listeners, imperative DOM measurement, timers you own.
