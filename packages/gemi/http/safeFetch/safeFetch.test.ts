import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  BlockedAddressError,
  BlockedHostError,
  ContentTypeError,
  DnsError,
  InvalidUrlError,
  NetworkError,
  safeFetch,
  SafeResponse,
  TimeoutError,
  TooLargeError,
  TooManyRedirectsError,
  type SafeFetchOptions,
} from "./index";

/**
 * A server on loopback stands in for "a public site". It is reached through
 * made-up names (`site.test`, `other.test`) that a test resolver maps to
 * 127.0.0.1, with exactly that address let through `allowPrivate`, so every
 * other private address stays blocked and a redirect into one is refused.
 */
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const to = url.searchParams.get("to");
      switch (url.pathname) {
        case "/echo":
          return Response.json({
            host: request.headers.get("host"),
            method: request.method,
            authorization: request.headers.get("authorization"),
            body: await request.text(),
          });
        case "/redirect":
          return new Response(null, {
            status: Number(url.searchParams.get("status") ?? 302),
            headers: { location: to! },
          });
        case "/loop":
          return new Response(null, {
            status: 302,
            headers: { location: "/loop" },
          });
        case "/chain": {
          const left = Number(url.searchParams.get("n"));
          return left === 0
            ? new Response("end")
            : new Response(null, {
                status: 302,
                headers: { location: `/chain?n=${left - 1}` },
              });
        }
        case "/big":
          return new Response("x".repeat(1000), {
            headers: { "content-type": "text/plain" },
          });
        case "/stream":
          return new Response(
            new ReadableStream({
              start(controller) {
                for (let index = 0; index < 10; index++)
                  controller.enqueue(new TextEncoder().encode("y".repeat(200)));
                controller.close();
              },
            }),
          );
        case "/gzip-bomb":
          return new Response(gzipSync(Buffer.alloc(1_000_000)), {
            headers: {
              "content-encoding": "gzip",
              "content-type": "text/plain",
            },
          });
        case "/gzip":
          return new Response(gzipSync("hello, gzip"), {
            headers: {
              "content-encoding": "gzip",
              "content-type": "text/plain",
            },
          });
        case "/html":
          return new Response("<p>hi</p>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        case "/json":
          return Response.json({ ok: true });
        case "/hang":
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return new Response("late");
        case "/slow-body":
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
                await new Promise((resolve) => setTimeout(resolve, 5_000));
                controller.close();
              },
            }),
          );
        case "/no-content":
          return new Response(null, { status: 204 });
        default:
          return new Response("ok", {
            headers: { "content-type": "text/plain" },
          });
      }
    },
  });
  base = `http://site.test:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const names: Record<string, string[]> = {
  "site.test": ["127.0.0.1"],
  "other.test": ["127.0.0.1"],
  "inside.test": ["10.1.2.3"],
  "metadata.test": ["169.254.169.254"],
  "mixed.test": ["8.8.8.8", "192.168.1.10"],
  "v6-loopback.test": ["::1"],
  "mapped.test": ["::ffff:127.0.0.1"],
};

async function testResolve(hostname: string) {
  const found = names[hostname];
  if (!found) throw new Error(`ENOTFOUND ${hostname}`);
  return found;
}

// The loopback server, and nothing else private.
const local: SafeFetchOptions = {
  resolve: testResolve,
  allowPrivate: ["127.0.0.1/32"],
  ports: "any",
};

describe("refused before connecting", () => {
  test.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://127.0.0.2:8080/", "loopback"],
    ["http://2130706433/", "loopback"],
    ["http://0x7f000001/", "loopback"],
    ["http://0x7f.1/", "loopback"],
    ["http://0177.0.0.1/", "loopback"],
    ["http://127.1/", "loopback"],
    ["http://[::1]/", "loopback"],
    ["http://[::ffff:127.0.0.1]/", "loopback"],
    ["http://[::ffff:7f00:1]/", "loopback"],
    ["http://0.0.0.0/", "unspecified"],
    ["http://[::]/", "unspecified"],
    ["http://10.0.0.1/", "private"],
    ["http://172.16.5.4/", "private"],
    ["http://192.168.0.1/", "private"],
    ["http://100.64.0.1/", "shared"],
    ["http://169.254.169.254/latest/meta-data/", "metadata"],
    ["http://0xA9FEA9FE/", "metadata"],
    ["http://[fd00:ec2::254]/", "metadata"],
    ["http://[::ffff:a9fe:a9fe]/", "metadata"],
    ["http://169.254.1.1/", "link-local"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[fc00::1]/", "unique-local"],
    ["http://224.0.0.1/", "multicast"],
    ["http://[64:ff9b::a00:1]/", "private"],
    ["http://inside.test/", "private"],
    ["http://metadata.test/", "metadata"],
    ["http://mixed.test/", "private"],
    ["http://v6-loopback.test/", "loopback"],
    ["http://mapped.test/", "loopback"],
  ])("%s (%s)", async (url, range) => {
    const error = await safeFetch(url, {
      resolve: testResolve,
      ports: "any",
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error.range).toBe(range);
    expect(error.code).toBe("blocked-address");
  });

  test.each([
    ["file:///etc/passwd", "scheme"],
    ["ftp://example.com/", "scheme"],
    ["gopher://example.com/", "scheme"],
    ["data:text/plain,hi", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["http://user:pass@example.com/", "credentials"],
    ["http://user@example.com/", "credentials"],
    ["http://example.com:8080/", "port"],
    ["https://example.com:22/", "port"],
    ["not a url", "malformed"],
    ["/relative", "malformed"],
  ])("%s (%s)", async (url, reason) => {
    const error = await safeFetch(url, { resolve: testResolve }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(InvalidUrlError);
    expect(error.reason).toBe(reason);
  });

  test("localhost, through the system resolver", async () => {
    const error = await safeFetch("http://localhost/").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error.range).toBe("loopback");
  });

  test("a name that doesn't resolve", async () => {
    await expect(
      safeFetch("http://nowhere.test/", { resolve: testResolve }),
    ).rejects.toBeInstanceOf(DnsError);
  });
});

describe("allowed", () => {
  test.each([
    ["through a name", () => `${base}/`],
    ["by its address", () => `http://127.0.0.1:${server.port}/`],
    ["by its address in decimal", () => `http://2130706433:${server.port}/`],
    ["by its address in hex", () => `http://0x7f.0.0.1:${server.port}/`],
  ])("%s", async (_, url) => {
    const response = await safeFetch(url(), local);
    expect(response).toBeInstanceOf(SafeResponse);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    // Bun before 1.4 doesn't report the remote address from node:http.
    expect([null, "127.0.0.1"]).toContain(response.address);
  });

  test("allowPrivate: true lets every private address through", async () => {
    const response = await safeFetch(`http://localhost:${server.port}/`, {
      allowPrivate: true,
      ports: "any",
    });
    expect(await response.text()).toBe("ok");
  });

  test("a range in allowPrivate lets only that range through", async () => {
    const error = await safeFetch("http://inside.test/", {
      ...local,
      allowPrivate: ["127.0.0.0/8"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedAddressError);
  });
});

describe("connects to the address it checked", () => {
  test("the name is resolved once and not again by the connection", async () => {
    let calls = 0;
    const response = await safeFetch(`${base}/echo`, {
      ...local,
      // First answer is checked; a rebinding resolver answers differently after.
      resolve: async () => (calls++ === 0 ? ["127.0.0.1"] : ["10.0.0.1"]),
    });
    expect(calls).toBe(1);
    expect(response.status).toBe(200);
  });

  test("the Host header is the name, not the address", async () => {
    const response = await safeFetch(`${base}/echo`, {
      ...local,
      headers: { host: "evil.test" },
    });
    expect((await response.json()).host).toBe(`site.test:${server.port}`);
  });
});

describe("redirects", () => {
  const redirect = (to: string, status = 302) =>
    `${base}/redirect?status=${status}&to=${encodeURIComponent(to)}`;

  test.each([
    ["http://169.254.169.254/latest/meta-data/", "metadata"],
    ["http://10.0.0.1/", "private"],
    ["http://0x0a000001/", "private"],
    ["http://[::1]/", "loopback"],
    ["http://[::ffff:10.0.0.1]/", "private"],
    ["http://inside.test/admin", "private"],
    ["http://metadata.test/", "metadata"],
  ])("a redirect to %s is refused (%s)", async (to, range) => {
    const error = await safeFetch(redirect(to), local).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error.range).toBe(range);
    expect(error.url).toBe(new URL(to).href);
  });

  test.each([307, 308, 301, 303])(
    "a %i redirect is checked too",
    async (status) => {
      const error = await safeFetch(
        redirect("http://10.0.0.1/", status),
        local,
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(BlockedAddressError);
    },
  );

  test("a redirect to another scheme is refused", async () => {
    const error = await safeFetch(redirect("file:///etc/passwd"), local).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(InvalidUrlError);
    expect(error.reason).toBe("scheme");
  });

  test("a redirect loop stops at maxRedirects", async () => {
    const error = await safeFetch(`${base}/loop`, {
      ...local,
      maxRedirects: 3,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TooManyRedirectsError);
    expect(error.limit).toBe(3);
  });

  test("redirects up to maxRedirects are followed", async () => {
    const response = await safeFetch(`${base}/chain?n=2`, {
      ...local,
      maxRedirects: 2,
    });
    expect(await response.text()).toBe("end");
    expect(response.redirected).toBe(true);
    expect(response.url).toBe(`${base}/chain?n=0`);
    await expect(
      safeFetch(`${base}/chain?n=3`, { ...local, maxRedirects: 2 }),
    ).rejects.toBeInstanceOf(TooManyRedirectsError);
  });

  test("redirect: manual returns the redirect", async () => {
    const response = await safeFetch(redirect("http://10.0.0.1/"), {
      ...local,
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://10.0.0.1/");
    expect(response.redirected).toBe(false);
  });

  test("credentials are dropped when a redirect leaves the origin", async () => {
    const other = `http://other.test:${server.port}/echo`;
    const response = await safeFetch(redirect(other), {
      ...local,
      headers: { authorization: "Bearer secret" },
    });
    expect((await response.json()).authorization).toBeNull();
    const same = await safeFetch(redirect(`${base}/echo`), {
      ...local,
      headers: { authorization: "Bearer secret" },
    });
    expect((await same.json()).authorization).toBe("Bearer secret");
  });

  test("303 turns a POST into a GET; 307 keeps it", async () => {
    const seeOther = await safeFetch(redirect(`${base}/echo`, 303), {
      ...local,
      method: "POST",
      body: "data",
    });
    expect(await seeOther.json()).toMatchObject({ method: "GET", body: "" });
    const temporary = await safeFetch(redirect(`${base}/echo`, 307), {
      ...local,
      method: "POST",
      body: "data",
    });
    expect(await temporary.json()).toMatchObject({
      method: "POST",
      body: "data",
    });
  });
});

describe("allow and deny", () => {
  test("a denied host", async () => {
    const error = await safeFetch(`${base}/`, {
      ...local,
      deny: ["site.test"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedHostError);
    expect(error.reason).toBe("denied");
  });

  test("a denied range", async () => {
    const error = await safeFetch(`${base}/`, {
      ...local,
      deny: ["127.0.0.0/8"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error.range).toBe("denied");
  });

  test("a host not on allow", async () => {
    const error = await safeFetch(`${base}/`, {
      ...local,
      allow: ["other.test"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedHostError);
    expect(error.reason).toBe("not-allowed");
  });

  test("a wildcard on allow, and a redirect off it", async () => {
    const response = await safeFetch(`${base}/`, {
      ...local,
      allow: ["*.test"],
    });
    expect(response.status).toBe(200);
    const error = await safeFetch(
      `${base}/redirect?to=${encodeURIComponent(`http://127.0.0.1:${server.port}/`)}`,
      {
        ...local,
        allow: ["site.test"],
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedHostError);
    expect(error.reason).toBe("not-allowed");
  });

  test("a range on allow", async () => {
    const response = await safeFetch(`${base}/`, {
      ...local,
      allow: ["127.0.0.1/32"],
    });
    expect(response.status).toBe(200);
    const error = await safeFetch("http://inside.test/", {
      ...local,
      allow: ["127.0.0.1/32"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error.range).toBe("not-allowed");
  });

  test("an allowed host is still refused at a private address", async () => {
    const error = await safeFetch("http://inside.test/", {
      ...local,
      allow: ["inside.test"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error.range).toBe("private");
  });

  test("a malformed rule is a configuration error", async () => {
    for (const rule of ["not a host", "10.0.0/8", "10.0.0.0/33", "127.1"]) {
      await expect(
        safeFetch(`${base}/`, { ...local, deny: [rule] }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe("response limits", () => {
  test("a declared length over maxSize", async () => {
    const error = await safeFetch(`${base}/big`, {
      ...local,
      maxSize: 100,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TooLargeError);
    expect(error.limit).toBe(100);
  });

  test("a streamed body over maxSize", async () => {
    const response = await safeFetch(`${base}/stream`, {
      ...local,
      maxSize: 500,
    });
    await expect(response.text()).rejects.toBeInstanceOf(TooLargeError);
  });

  test("maxSize counts decompressed bytes", async () => {
    const response = await safeFetch(`${base}/gzip-bomb`, {
      ...local,
      maxSize: 10_000,
    });
    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(TooLargeError);
  });

  test("a gzip body is decoded", async () => {
    const response = await safeFetch(`${base}/gzip`, local);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("hello, gzip");
  });

  test("contentTypes", async () => {
    const html = await safeFetch(`${base}/html`, {
      ...local,
      contentTypes: ["text/html"],
    });
    expect(await html.text()).toBe("<p>hi</p>");
    const wildcard = await safeFetch(`${base}/html`, {
      ...local,
      contentTypes: ["text/*"],
    });
    expect(wildcard.status).toBe(200);
    const error = await safeFetch(`${base}/json`, {
      ...local,
      contentTypes: ["text/html"],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ContentTypeError);
    expect(error.contentType).toBe("application/json");
  });

  test("a body-less response", async () => {
    const response = await safeFetch(`${base}/no-content`, local);
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    const head = await safeFetch(`${base}/`, { ...local, method: "HEAD" });
    expect(head.body).toBeNull();
  });
});

describe("timeouts and aborts", () => {
  test("timeout covers waiting for the response", async () => {
    const error = await safeFetch(`${base}/hang`, {
      ...local,
      timeout: 200,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.phase).toBe("total");
  });

  test("timeout covers reading the body", async () => {
    const response = await safeFetch(`${base}/slow-body`, {
      ...local,
      timeout: 300,
    });
    await expect(response.text()).rejects.toBeInstanceOf(TimeoutError);
  });

  test("connectTimeout covers resolving", async () => {
    const error = await safeFetch(`${base}/`, {
      ...local,
      connectTimeout: 100,
      resolve: () => new Promise(() => {}),
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.phase).toBe("connect");
  });

  test("the caller's signal rejects with its reason", async () => {
    const controller = new AbortController();
    const pending = safeFetch(`${base}/hang`, {
      ...local,
      signal: controller.signal,
    });
    const reason = new Error("stop");
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
  });

  test("a refused connection is a NetworkError", async () => {
    const closed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const port = closed.port;
    closed.stop(true);
    const error = await safeFetch(`http://site.test:${port}/`, local).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(NetworkError);
  });
});

test("sends a body with its content type", async () => {
  const response = await safeFetch(`${base}/echo`, {
    ...local,
    method: "POST",
    body: new URLSearchParams({ a: "1" }),
  });
  expect(await response.json()).toMatchObject({ method: "POST", body: "a=1" });
});
