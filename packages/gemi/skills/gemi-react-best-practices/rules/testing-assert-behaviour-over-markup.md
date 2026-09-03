---
title: Mount and Query the DOM — Do Not Scrape Rendered Markup
impact: MEDIUM-HIGH
impactDescription: catches real regressions instead of string drift
tags: testing, testing-library, house-style
---

## Mount and Query the DOM — Do Not Scrape Rendered Markup

Asserting on `renderToStaticMarkup` / `renderToString` output — substring matches,
regex scrapes for `href=`, index arithmetic to prove ordering — tests the markup
rather than the component. It passes when the component is broken and fails when a
class name changes.

**Incorrect:**

```tsx
const html = renderToStaticMarkup(<ProductList products={products} />);
expect(html).toContain("Chair");
expect(html.indexOf("Chair")).toBeLessThan(html.indexOf("Desk"));
expect(html).toMatch(/href="\/app\/abc\/products\/1"/);
```

**Correct:**

```tsx
render(<Page {...}><ProductList /></Page>);

expect(screen.getByRole("link", { name: "Chair" })).toHaveAttribute(
  "href", "/app/abc/products/1",
);
expect(
  screen.getByText("Chair").compareDocumentPosition(screen.getByText("Desk")),
).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
```

Use `getByRole` / `getByLabelText`, `compareDocumentPosition` for order, and
`label[for]` for input association. **The one exception is a test whose SUBJECT is
the server payload** — e.g. guarding that a virtualised grid does not ship an empty
shell. Say so in the file when you take it.

**Assert what goes over the wire, not how a query was configured.** Checking that
`lazy` or `refreshInterval` was passed tests the arguments; it cannot tell a working
pager from one that never fetched. A non-lazy query is proved by a request arriving
on mount, a lazy one by no request arriving until something asks.

**Mock HTTP with MSW, not by replacing `globalThis.fetch`.** `setupServer` +
`server.listen({ onUnhandledRequest: "error" })` makes an undeclared request fail
instead of silently resolving, and lets a case assert against the real `Request` —
resolved URL, method, headers, parsed body.

**Make a stub load-bearing.** A test that removes `crypto.randomUUID` to reach a
fallback, then asserts a shape both branches satisfy, passes either way. Assert the
exact value.
