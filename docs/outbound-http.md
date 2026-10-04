# Outbound HTTP

When your server fetches a URL that a user typed (a link preview, a webhook target, a feed to import, a site to read), a plain `fetch` will happily reach `http://localhost:5432`, `http://169.254.169.254/` (the cloud metadata endpoint) or any address inside your network. `safeFetch` from `gemi/http` is `fetch` for those URLs: it only reaches the public internet.

```typescript
import { safeFetch, SafeFetchError } from "gemi/http";

try {
  const response = await safeFetch(url, {
    timeout: 15_000,
    maxSize: 2 * 1024 * 1024,
    contentTypes: ["text/html"],
  });
  const html = await response.text();
} catch (error) {
  if (error instanceof SafeFetchError) {
    // error.code says why, in a form you can turn into a message:
    // "invalid-url", "blocked-host", "blocked-address", "dns", "timeout",
    // "too-large", "content-type", "too-many-redirects" or "network".
  }
  throw error;
}
```

It is server-only (it uses `node:http`), and returns a standard `Response` (a `SafeResponse`, with `url`, `redirected` and the `address` it connected to).

## What it checks

- **The URL.** Only `http` and `https`, only ports 80 and 443 (set `ports`), and no username or password in it.
- **The addresses.** The host is resolved first, and refused when any address it resolves to is not public: loopback, private (RFC 1918), shared (CGNAT), link-local, cloud metadata (`169.254.169.254`, `fd00:ec2::254`, `168.63.129.16`), unique-local, multicast, documentation, benchmarking, unspecified and reserved ranges, for IPv4 and IPv6. IPv6 forms that carry an IPv4 address (`::ffff:10.0.0.1`, NAT64, 6to4) are judged by that address, and IPv4 written as `2130706433`, `0x7f.1` or `0177.0.0.1` is the same address as `127.0.0.1`.
- **The connection.** It connects to the address it checked, not to whatever the name resolves to a moment later, so a DNS answer that changes between the check and the connection (DNS rebinding) can't reach inside. The host name is still sent as `Host` and as TLS SNI, and the certificate is verified against it.
- **Redirects.** Followed by hand, and each hop goes through every check above. After `maxRedirects` (5) it throws `TooManyRedirectsError`. `Authorization` and `Cookie` are dropped when a redirect leaves the origin.
- **The response.** `timeout` (30 s) covers the whole request including reading the body; `connectTimeout` (10 s) covers resolving and connecting on each hop. A body over `maxSize` (10 MiB, counted after gzip/deflate/brotli decoding) is cut off with `TooLargeError`: up front when `Content-Length` says so, otherwise from `response.text()` and friends once the limit is passed.

## Options

| Option | Default | |
|---|---|---|
| `method`, `headers`, `body`, `signal` | | As for `fetch`. `Host` and the connection headers can't be set. |
| `timeout` | `30_000` | The whole request, in ms. |
| `connectTimeout` | `10_000` | Resolving and connecting, per hop, in ms. |
| `maxSize` | 10 MiB | Largest body, in decoded bytes. |
| `maxRedirects` | `5` | |
| `redirect` | `"follow"` | `"manual"` returns the redirect response unfollowed. |
| `contentTypes` | any | e.g. `["text/html", "image/*"]`; anything else throws `ContentTypeError`. |
| `ports` | `[80, 443]` | Or `"any"`. |
| `allow` | none | Host names (`"api.example.com"`, `"*.example.com"`) and IP ranges (`"203.0.113.0/24"`). When set, only these are reached. An allowed host at a private address is still refused. |
| `deny` | none | Same notation; never reached. Wins over `allow`. |
| `allowPrivate` | `false` | `true` lets private addresses through (tests, local development); a list of ranges (`["10.20.0.0/16"]`) lets only those through. Never set it from user input. |
| `resolve` | system resolver | `(hostname) => Promise<string[]>`. The connection uses exactly what it returns, after the checks. |

## Errors

All extend `SafeFetchError`, which has `code` and `url` (the hop that failed).

| Error | `code` | When |
|---|---|---|
| `InvalidUrlError` | `invalid-url` | Not an http(s) URL, credentials in it, or a port not allowed (`reason`: `malformed`, `scheme`, `credentials`, `port`). |
| `BlockedHostError` | `blocked-host` | The host is on `deny`, or not on `allow`. |
| `BlockedAddressError` | `blocked-address` | The host is or resolves to a non-public address (`range` says which kind) or one in a `deny` range. |
| `DnsError` | `dns` | The name didn't resolve. |
| `TimeoutError` | `timeout` | `phase` is `connect` or `total`. |
| `TooLargeError` | `too-large` | The body is over `maxSize`. |
| `ContentTypeError` | `content-type` | The type isn't in `contentTypes`. |
| `TooManyRedirectsError` | `too-many-redirects` | More than `maxRedirects` redirects. |
| `NetworkError` | `network` | Refused, reset, a TLS failure, a malformed response. |

Aborting through your own `signal` rejects with the signal's reason, as `fetch` does.

`classifyAddress(ip)` is exported too: it returns `{ kind, range }` for a non-public address and `null` for a public one, for when you need to check an address you got some other way.

## In tests

A test server on `localhost` is a private address, so let it through explicitly:

```typescript
import { safeFetch } from "gemi/http";

const response = await safeFetch(`http://localhost:${port}/feed`, {
  allowPrivate: ["127.0.0.1/32", "::1/128"],
  ports: "any",
});
```

## Limits

- Proxies from `HTTP_PROXY`/`HTTPS_PROXY` are not used; the request goes out directly.
- Only the request is guarded. A URL you hand to something else that fetches it (a headless browser, an image CDN, a queue worker using plain `fetch`) needs that component to guard it.
