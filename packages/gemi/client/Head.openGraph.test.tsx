import { afterEach, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { Metadata, type OpenGraphParams } from "../http/Metadata";
import { Head } from "./Head";
import { ServerDataContext, type ServerDataContextValue } from "./ServerDataProvider";

/** `Meta.openGraph` without an image, and `twitter:card` (#961). */

afterEach(() => {
  vi.unstubAllEnvs();
});

function render(params: OpenGraphParams) {
  const metadata = new Metadata();
  metadata.openGraph(params);
  const html = renderToString(
    <ServerDataContext.Provider value={{ meta: metadata.render() } as unknown as ServerDataContextValue}>
      <Head />
    </ServerDataContext.Provider>,
  );
  const tags = [...html.matchAll(/<meta (property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"\/>/g)];
  return tags.map(([, , key, content]) => `${key}=${content}`);
}

const page = { title: "Home", type: "website", url: "https://example.com/" };

test("without an image: no og:image, and a summary card", () => {
  expect(render({ ...page, description: "Hello" })).toEqual([
    "og:title=Home",
    "og:type=website",
    "og:url=https://example.com/",
    "og:description=Hello",
    "twitter:card=summary",
  ]);
});

test("with an image: the same tags as before, and a large image card", () => {
  expect(
    render({ ...page, image: "https://cdn.example.com/a.png", imageAlt: "A", imageWidth: 1200, imageHeight: 630 }),
  ).toEqual([
    "og:title=Home",
    "og:type=website",
    "og:url=https://example.com/",
    "og:image=https://cdn.example.com/a.png",
    "og:image:alt=A",
    "og:image:width=1200",
    "og:image:height=630",
    "twitter:image=https://cdn.example.com/a.png",
    "twitter:card=summary_large_image",
    "twitter:image:alt=A",
    "twitter:image:width=1200",
    "twitter:image:height=630",
  ]);
});

test("a twitterImage alone gives a large image card but no og:image", () => {
  expect(render({ ...page, twitterImage: "https://cdn.example.com/t.png" })).toEqual([
    "og:title=Home",
    "og:type=website",
    "og:url=https://example.com/",
    "twitter:image=https://cdn.example.com/t.png",
    "twitter:card=summary_large_image",
  ]);
});

test("an explicit twitterCard wins", () => {
  expect(render({ ...page, image: "https://cdn.example.com/a.png", twitterCard: "summary" })).toContain(
    "twitter:card=summary",
  );
  expect(render({ ...page, twitterCard: "summary_large_image" })).toContain("twitter:card=summary_large_image");
});

test("image paths get the app origin, each on its own", () => {
  vi.stubEnv("HOST_NAME", "https://app.example.com");
  vi.stubEnv("APP_URL", "");
  expect(render({ ...page, image: "/og.png" })).toEqual(
    expect.arrayContaining(["og:image=https://app.example.com/og.png", "twitter:image=https://app.example.com/og.png"]),
  );
  expect(render({ ...page, image: "/og.png", twitterImage: "https://cdn.example.com/t.png" })).toEqual(
    expect.arrayContaining(["og:image=https://app.example.com/og.png", "twitter:image=https://cdn.example.com/t.png"]),
  );
  expect(render({ ...page, twitterImage: "/t.png" })).toContain("twitter:image=https://app.example.com/t.png");
});
