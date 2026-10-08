// The client-side navigation runtime of a static view with `.static({ navigation })`
// (#865), and the island loader it carries. This is the readable source:
// `bun scripts/build-static-navigation.ts` minifies it into `../staticNavigationRuntime.ts`,
// whose string is what a page inlines (CSP-hashed, so it is byte-for-byte constant).
//
// Plain browser JavaScript with no imports. A test runs the built string with
// `new Function("__import", "location", "fetch", source)`, so `import(`, `location`
// and `fetch` are the only ways out of it to the network or the address bar; keep
// it that way (`location` and `fetch` unqualified, one `import(`).
//
// How it works, in short:
// - Islands: the same table and schedules as `ISLAND_LOADER_SOURCE`, but as a
//   function (`hydrate(root, table)`) that runs again for each new page, and it
//   keeps what `h` returns (the React root) on the marker so a navigation can
//   `unmount()` it.
// - Clicks on eligible same-origin links fetch the next document. It is swapped
//   in only when its `<meta name="gemi-static">` (layout | build | version) and
//   its stylesheets equal this one's; anything else, an error or a timeout is a
//   full load (`location.assign`).
// - The swap: title, `<html lang dir>`, the head tags `Head`/`Meta` own, then the
//   body (`data-gemi-persist` elements and the stylesheets stay in place).

const d = document;
const w = window;
const h = history;

// A runtime started again in the same window (a test) replaces the previous one.
w.__gemi_nav?.d();
const stop = new AbortController();
const on = (target, type, fn, options) =>
  target.addEventListener(type, fn, { signal: stop.signal, ...options });
// `p` is the last page-load detail (for `onStaticNavigate`), `d` disposes this runtime.
const G = (w.__gemi_nav = { d: () => stop.abort() });

// --- Islands -----------------------------------------------------------------

const mount = (marker, entry) => {
  if (!marker.g) {
    marker.g = 1;
    import(entry.s)
      .then((x) => {
        // A navigation may have removed it while its code loaded.
        if (marker.isConnected) marker.r = x.h(marker, x.m[entry.e]);
      })
      .catch((reason) => console.error(reason));
  }
};

const tableOf = (doc) => {
  const script = doc.getElementById("gemi-islands");
  return script ? JSON.parse(script.textContent) : { i: [] };
};

// Markers of an earlier page (`o`) index that page's table, not this one.
const hydrate = (root, table) => {
  for (const marker of root.querySelectorAll("gemi-island")) {
    const entry = table.i[marker.dataset.island];
    if (!entry || marker.o) continue;
    if (entry.l == "eager") mount(marker, entry);
    else if (entry.l == "idle" || !w.IntersectionObserver || !marker.children.length)
      (w.requestIdleCallback || setTimeout)(() => mount(marker, entry));
    else {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((x) => x.isIntersecting)) {
          observer.disconnect();
          mount(marker, entry);
        }
      });
      for (const child of marker.children) observer.observe(child);
    }
  }
};

// --- Documents ---------------------------------------------------------------

const IDENTITY = 'meta[name="gemi-static"]';
const SHEETS = "style:not([data-gemi-fonts]),link[rel=stylesheet]";
// What `Head` and `Meta` render per page; the rest of the head stays.
const HEAD =
  'meta[name]:not([name=viewport]),meta[property],link[rel~=canonical],link[rel~=alternate],link[rel~=icon],link[rel=preload][as=font],style[data-gemi-fonts],script[type="application/ld+json"]';

const identity = (doc) => doc.querySelector(IDENTITY)?.content;
const sheets = (doc) => [...doc.querySelectorAll(SHEETS)].map((e) => e.outerHTML).join();
const withoutHash = (url) => url.href.split("#")[0];

// The polite live region that announces each new page's title.
const live = d.createElement("div");
live.setAttribute("aria-live", "polite");
live.style.cssText =
  "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
d.body.append(live);

const pageLoad = (initial) => {
  G.p = { url: location.href, title: d.title, initial };
  d.dispatchEvent(new CustomEvent("gemi:page-load", { detail: G.p }));
};

// --- Fetching and the prefetch cache -------------------------------------------

// url -> [fetched at, Promise<[final url, html]>], least recently used first.
const cache = new Map();

const get = (key) => {
  let hit = cache.get(key);
  if (!hit || Date.now() - hit[0] > 3e4) {
    const promise = fetch(key, {
      headers: { accept: "text/html", "x-gemi-navigate": "1" },
      signal: AbortSignal.timeout(1e4),
    }).then((res) => {
      if (
        !res.ok ||
        !/^text\/html/.test(res.headers.get("content-type")) ||
        new URL(res.url || key).origin != location.origin
      )
        throw res;
      return res.text().then((html) => [res.url || key, html]);
    });
    hit = [Date.now(), promise];
    promise.catch(() => cache.get(key) == hit && cache.delete(key));
  }
  cache.delete(key);
  cache.set(key, hit);
  if (cache.size > 10) cache.delete(cache.keys().next().value);
  return hit[1];
};

// --- Links -------------------------------------------------------------------

// The URL an event's link leads to, when a client navigation may take it there.
const linkOf = (event) => {
  const a = event.target.closest?.("a[href]");
  const target = a?.getAttribute("target");
  if (
    !a ||
    (target && target != "_self") ||
    a.hasAttribute("download") ||
    /(^|\s)external(\s|$)/i.test(a.getAttribute("rel")) ||
    a.closest("[data-gemi-reload]")
  )
    return;
  const url = new URL(a.getAttribute("href"), d.baseURI);
  // A link within this page (`#section`, `#`) stays a native anchor.
  if (url.origin == location.origin && !(url.href.includes("#") && withoutHash(url) == withoutHash(location)))
    return url;
};

// --- History and scroll --------------------------------------------------------

// Scroll positions by history entry: each entry the runtime made has a key `g`.
const scrolls = {};
const key = () => Math.random().toString(36).slice(2);
const stamp = () => h.state?.g || h.replaceState({ ...h.state, g: key() }, "");
let shown = withoutHash(location);

// --- Navigation ----------------------------------------------------------------

let current = 0;

const focus = (el) => {
  if (!el.hasAttribute("tabindex")) {
    el.setAttribute("tabindex", "-1");
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
  }
  el.focus({ preventScroll: true });
};

const swap = (doc) => {
  const body = d.body;
  const next = doc.body;
  const table = tableOf(doc);
  const root = d.documentElement;

  d.title = doc.title;
  for (const name of ["lang", "dir"]) {
    const value = doc.documentElement.getAttribute(name);
    if (value == null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  for (const e of d.head.querySelectorAll(HEAD)) e.remove();
  const preloaded = new Set(
    [...d.querySelectorAll("link[rel=modulepreload]")].map((l) => l.getAttribute("href")),
  );
  d.head.append(
    ...doc.head.querySelectorAll(HEAD),
    ...[...doc.head.querySelectorAll("link[rel=modulepreload]")].filter(
      (l) => !preloaded.has(l.getAttribute("href")),
    ),
  );

  // Persisted elements: [the new page's placeholder, the element kept].
  const persisted = new Map(
    [...body.querySelectorAll("[data-gemi-persist]")].map((e) => [e.dataset.gemiPersist, e]),
  );
  const kept = [...next.querySelectorAll("[data-gemi-persist]")]
    .map((e) => [e, persisted.get(e.dataset.gemiPersist)])
    .filter((pair) => pair[1]);

  // Unmount the islands that leave, innermost first, so their effects clean up.
  for (const marker of [...body.querySelectorAll("gemi-island")].reverse()) {
    marker.o = 1;
    if (!kept.some((pair) => pair[1].contains(marker))) {
      try {
        marker.r?.unmount();
      } catch (reason) {
        console.error(reason);
      }
    }
  }
  for (const [placeholder, element] of kept) placeholder.replaceWith(element);

  // The stylesheets are the same (checked), so the old ones stay where they
  // are rather than be parsed again. (Copies: removing from a live
  // collection while iterating it would skip nodes.)
  for (const node of [...body.childNodes]) if (!node.matches?.(SHEETS)) node.remove();
  for (const node of [...next.children]) if (node.matches(SHEETS)) node.remove();
  for (const attribute of [...body.attributes]) body.removeAttribute(attribute.name);
  for (const attribute of next.attributes) body.setAttribute(attribute.name, attribute.value);
  body.append(...next.childNodes, live);
  hydrate(body, table);
};

// `push`: a link was followed. Otherwise the entry was traversed to (popstate).
const go = async (url, push) => {
  const run = ++current;
  const at = !push && scrolls[h.state?.g];
  h.scrollRestoration = "manual";
  try {
    const [final, html] = await get(withoutHash(url));
    if (run != current) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (identity(doc) == null || identity(doc) != identity(d) || sheets(doc) != sheets(d)) throw 0;
    if (push) {
      const next = new URL(final);
      next.hash = url.hash;
      h.pushState({ g: key() }, "", next.href);
    }
    shown = withoutHash(location);
    swap(doc);
    const target = push && url.hash && d.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (target) target.scrollIntoView({ behavior: "instant" });
    else w.scrollTo({ left: at?.[0] || 0, top: at?.[1] || 0, behavior: "instant" });
    if (push) focus(target || d.querySelector("h1") || d.querySelector("main") || d.body);
    live.textContent = d.title;
    pageLoad(false);
  } catch {
    if (run != current) return;
    if (push) location.assign(url.href);
    else location.reload();
  }
};

on(d, "click", (event) => {
  if (
    event.defaultPrevented ||
    event.button ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const url = linkOf(event);
  if (
    url &&
    d.dispatchEvent(
      new CustomEvent("gemi:before-navigate", { cancelable: true, detail: { url: url.href } }),
    )
  ) {
    event.preventDefault();
    stamp();
    scrolls[h.state.g] = [w.scrollX, w.scrollY];
    go(url, 1);
  }
});

on(w, "popstate", () => {
  if (withoutHash(location) == shown) {
    // Within this document (a `#hash` entry): only the scroll changes.
    const at = scrolls[h.state?.g];
    if (at) w.scrollTo({ left: at[0], top: at[1], behavior: "instant" });
  } else if (h.state?.g) go(new URL(location.href), 0);
  // An entry the runtime did not make: its document is unknown.
  else location.reload();
});

on(w, "hashchange", stamp);
on(w, "scroll", () => h.state?.g && (scrolls[h.state.g] = [w.scrollX, w.scrollY]), { passive: true });

// --- Prefetch ------------------------------------------------------------------

let timer;
const prefetch = (event) => {
  if (d.querySelector(IDENTITY)?.dataset.prefetch == "none" || navigator.connection?.saveData) return;
  const url = linkOf(event);
  if (url && withoutHash(url) != withoutHash(location)) get(withoutHash(url));
};
on(d, "pointerover", (event) => {
  clearTimeout(timer);
  timer = setTimeout(() => prefetch(event), 65);
});
on(d, "pointerout", () => clearTimeout(timer));
on(d, "focusin", prefetch);
on(d, "touchstart", prefetch, { passive: true });

// --- Start -------------------------------------------------------------------

stamp();
hydrate(d, tableOf(d));
pageLoad(true);
