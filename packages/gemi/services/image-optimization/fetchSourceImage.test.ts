import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  fetchSourceImage,
  ImageSourceError,
  type FetchSourceImageOptions,
} from "./fetchSourceImage";

/**
 * #1032. A loopback server plays both the app itself (`localOrigin`) and an
 * allowed CDN (`cdn.test`, which the test resolver maps to 127.0.0.1, let
 * through with exactly that address). Every other private address stays
 * blocked, as in production.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let server: ReturnType<typeof Bun.serve>;
let local: string;
const OWN = "https://app.example";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const to = url.searchParams.get("to");
      switch (url.pathname) {
        case "/a.png":
          return new Response(PNG, {
            headers: { "content-type": "image/png", "cache-control": "public, max-age=60" },
          });
        case "/html":
          return new Response("<p>secret</p>", { headers: { "content-type": "text/html" } });
        case "/untyped":
          return new Response(PNG);
        case "/big":
          return new Response(new Uint8Array(4096), { headers: { "content-type": "image/png" } });
        case "/hang":
          return new Promise((resolve) =>
            setTimeout(() => resolve(new Response(PNG, { headers: { "content-type": "image/png" } })), 2_000),
          );
        case "/redirect":
          return new Response(null, { status: 302, headers: { location: to! } });
        case "/missing":
          return new Response("nope", { status: 404 });
        default:
          return new Response("?", { status: 500 });
      }
    },
  });
  local = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function options(overrides: Partial<FetchSourceImageOptions> = {}): FetchSourceImageOptions {
  return {
    ownOrigins: [OWN],
    localOrigin: local,
    allowedHosts: [],
    maxSize: 1024,
    timeout: 1_000,
    external: {
      resolve: async (host) =>
        host === "cdn.test" ? ["127.0.0.1"] : host === "inside.test" ? ["10.0.0.5"] : [],
      allowPrivate: ["127.0.0.1/32"],
      ports: "any",
    },
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ImageSourceError);
  return error as ImageSourceError;
}

describe("the app's own images", () => {
  test("a path is fetched from the app itself", async () => {
    const image = await fetchSourceImage("/a.png", options());
    expect(new Uint8Array(image.bytes)).toEqual(PNG);
    expect(image.cacheControl).toBe("public, max-age=60");
  });

  test("a URL on the app's own origin is fetched from the app itself", async () => {
    const image = await fetchSourceImage(`${OWN}/a.png`, options());
    expect(new Uint8Array(image.bytes)).toEqual(PNG);
  });

  test("the resize route itself is refused", async () => {
    const error = await rejection(
      fetchSourceImage("/api/__gemi__/services/image/resize?url=/a.png", options()),
    );
    expect(error.status).toBe(403);
  });
});

describe("other hosts", () => {
  test.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1/admin"],
    ["localhost", "http://localhost:5432/"],
    ["a private range", "http://10.0.0.1/"],
    ["a public host not on the list", "https://example.com/a.png"],
    ["protocol-relative", "//example.com/a.png"],
  ])("%s is refused without an allowlist", async (_, url) => {
    const error = await rejection(fetchSourceImage(url, options()));
    expect(error.status).toBe(403);
    expect(error.message).not.toContain(new URL(url, OWN).host);
  });

  test("a non-http scheme is refused", async () => {
    const error = await rejection(fetchSourceImage("file:///etc/passwd", options()));
    expect(error.status).toBe(400);
  });

  test("an allowed host is fetched", async () => {
    const image = await fetchSourceImage(
      `http://cdn.test:${server.port}/a.png`,
      options({ allowedHosts: ["cdn.test"] }),
    );
    expect(new Uint8Array(image.bytes)).toEqual(PNG);
  });

  test("a wildcard entry covers subdomains only", async () => {
    const error = await rejection(
      fetchSourceImage(`http://cdn.test:${server.port}/a.png`, options({ allowedHosts: ["*.cdn.test"] })),
    );
    expect(error.status).toBe(403);
  });

  test("with an allowlist, internal addresses are still refused", async () => {
    for (const url of ["http://169.254.169.254/", "http://127.0.0.2/", "http://inside.test/"]) {
      const error = await rejection(
        fetchSourceImage(url, options({ allowedHosts: ["cdn.test", "inside.test"] })),
      );
      expect(error.status).toBe(403);
    }
  });
});

describe("redirects are checked at every hop", () => {
  test("an allowed host redirecting to cloud metadata is refused", async () => {
    const error = await rejection(
      fetchSourceImage(
        `http://cdn.test:${server.port}/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/")}`,
        options({ allowedHosts: ["cdn.test"] }),
      ),
    );
    expect(error.status).toBe(403);
  });

  test("the app redirecting to a host not on the list is refused", async () => {
    const error = await rejection(
      fetchSourceImage(`/redirect?to=${encodeURIComponent("http://127.0.0.1:22/")}`, options()),
    );
    expect(error.status).toBe(403);
  });

  test("the app redirecting to an allowed host is followed", async () => {
    const image = await fetchSourceImage(
      `/redirect?to=${encodeURIComponent(`http://cdn.test:${server.port}/a.png`)}`,
      options({ allowedHosts: ["cdn.test"] }),
    );
    expect(new Uint8Array(image.bytes)).toEqual(PNG);
  });

  test("a relative redirect stays on the app", async () => {
    const image = await fetchSourceImage("/redirect?to=/a.png", options());
    expect(new Uint8Array(image.bytes)).toEqual(PNG);
  });

  test("a loop gives up", async () => {
    const error = await rejection(
      fetchSourceImage(`/redirect?to=${encodeURIComponent("/redirect?to=/redirect")}`, options({ maxRedirects: 1 })),
    );
    expect(error.status).toBe(502);
  });
});

describe("the answer", () => {
  test.each([["/html"], ["/untyped"]])("%s, not an image, is refused", async (path) => {
    const error = await rejection(fetchSourceImage(path, options()));
    expect(error.status).toBe(415);
  });

  test("a body over maxSize is refused", async () => {
    const error = await rejection(fetchSourceImage("/big", options({ maxSize: 1024 })));
    expect(error.status).toBe(413);
  });

  test("a slow source times out", async () => {
    const error = await rejection(fetchSourceImage("/hang", options({ timeout: 200 })));
    expect(error.status).toBe(504);
  });

  test("a missing image is a 404 that doesn't echo the URL", async () => {
    const error = await rejection(fetchSourceImage("/missing", options()));
    expect(error.status).toBe(404);
    expect(error.message).toBe("Image not found");
  });
});
