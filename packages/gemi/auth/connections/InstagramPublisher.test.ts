import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { LockManager } from "../../services/lock/LockManager";
import { MemoryLockStore } from "../../services/lock/MemoryLockStore";
import { ConnectionManager, type ProviderConnection } from "./ConnectionManager";
import { MemoryConnectionStore } from "./ConnectionStore";
import { OAuthReconnectRequiredError } from "./errors";
import { InstagramConnectionProvider } from "./InstagramConnectionProvider";
import { Instagram, InstagramPublishError, type InstagramPublisherOptions } from "./InstagramPublisher";
import { OAuthConnectionProvider } from "./OAuthConnectionProvider";

/**
 * The publishing helper over an Instagram connection, against a faked Graph
 * API (`ConnectionManager.fake`): containers, polling, publishing, and how
 * Graph's errors are classified. One test runs unfaked, with `fetch`
 * stubbed, for the reconnect path.
 */

const IG_ID = "17841400000000123";
const TOKEN = "IGAAtokenvalue0123456789abcdefghij";
const IMAGE = "https://cdn.example.com/a.jpg";
const VIDEO = "https://cdn.example.com/a.mp4";

type Call = { method: string; path: string; query: Record<string, string>; form: Record<string, string> };
type Answer = Response | ((call: Call) => Response);

let calls: Call[];
/** Queued answers per `METHOD path`; the last one repeats. */
let answers: Map<string, Answer[]>;
let nextId: number;
let manager: ConnectionManager;

function graphError(status: number, error: Record<string, unknown>) {
  return Response.json({ error: { type: "OAuthException", message: "Something went wrong", ...error } }, { status });
}

function on(key: string, ...queue: Answer[]) {
  answers.set(key, queue);
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const call: Call = {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    form: request.method === "POST" ? Object.fromEntries(new URLSearchParams(await request.text())) : {},
  };
  calls.push(call);
  const key = `${call.method} ${call.path}`;
  const queue = answers.get(key);
  if (queue && queue.length > 0) {
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof answer === "function" ? answer(call) : answer.clone();
  }
  if (call.method === "POST" && call.path.endsWith("/media")) {
    // Raw: a container id the way Graph sends it.
    return new Response(`{"id":"${nextId++}"}`);
  }
  if (call.method === "POST" && call.path.endsWith("/media_publish")) return Response.json({ id: "90001" });
  if (call.method === "GET" && call.query.fields === "permalink") {
    return Response.json({ permalink: `https://www.instagram.com/p/abc/`, id: call.path.split("/").pop() });
  }
  if (call.method === "GET" && call.query.fields === "status_code,status") {
    return Response.json({ status_code: "FINISHED", status: "Finished: Media has been uploaded and it is ready to be published." });
  }
  return new Response("not found", { status: 404 });
}

const FAST: InstagramPublisherOptions = { pollIntervalMs: 1, maxPollIntervalMs: 2, timeoutMs: 1000 };

function provider(overrides: ConstructorParameters<typeof InstagramConnectionProvider>[0] = {}) {
  return new InstagramConnectionProvider({ clientId: "ig-app", clientSecret: "ig-secret", multiple: true, ...overrides });
}

async function connect(scopes = ["instagram_business_basic", "instagram_business_content_publish"]): Promise<ProviderConnection> {
  return manager.save("user-1", "instagram", { accessToken: TOKEN, providerAccountId: IG_ID, scopes });
}

beforeEach(() => {
  const application = new Application();
  application.instance(LockManager, new LockManager(new MemoryLockStore()));
  Application.setInstance(application);
  calls = [];
  answers = new Map();
  nextId = 1000;
  manager = new ConnectionManager({
    providers: {
      instagram: provider(),
      versioned: provider({ graphApiVersion: "v25.0" }),
      figma: new OAuthConnectionProvider({
        authorizeUrl: "https://figma.example/oauth",
        tokenUrl: "https://figma.example/token",
        clientId: "c",
        clientSecret: "s",
        apiBaseUrl: "https://api.figma.example",
        scopes: [],
      }),
    },
    store: new MemoryConnectionStore(),
  });
  manager.fake({ instagram: handler, versioned: handler });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Application.setInstance(undefined);
});

const statusPolls = () => calls.filter((call) => call.query.fields === "status_code,status");

describe("publishImage", () => {
  test("creates the container, publishes it and reads the permalink", async () => {
    const ig = await connect();
    const result = await Instagram.for(ig, FAST).publishImage({
      imageUrl: IMAGE,
      caption: "Hello #gemi",
      altText: "A cat",
      userTags: [{ username: "friend", x: 0.5, y: 0.25 }],
      locationId: "1234",
    });
    expect(result).toEqual({ mediaId: "90001", permalink: "https://www.instagram.com/p/abc/" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /${IG_ID}/media`,
      `POST /${IG_ID}/media_publish`,
      "GET /90001",
    ]);
    expect(calls[0]!.form).toEqual({
      image_url: IMAGE,
      caption: "Hello #gemi",
      alt_text: "A cat",
      user_tags: JSON.stringify([{ username: "friend", x: 0.5, y: 0.25 }]),
      location_id: "1234",
    });
    expect(calls[1]!.form).toEqual({ creation_id: "1000" });
    // The token rides in the query, as connection.fetch sends it.
    expect(calls[0]!.query.access_token).toBe(TOKEN);
  });

  test("uses the provider's graphApiVersion, and the publisher's over it", async () => {
    const ig = await manager.save("user-1", "versioned", { accessToken: TOKEN, providerAccountId: IG_ID, scopes: ["instagram_business_content_publish"] });
    await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE });
    expect(calls[0]!.path).toBe(`/v25.0/${IG_ID}/media`);

    calls = [];
    await Instagram.for(ig, { ...FAST, graphApiVersion: "v26.0" }).publishImage({ imageUrl: IMAGE });
    expect(calls[0]!.path).toBe(`/v26.0/${IG_ID}/media`);
  });

  test("a permalink Instagram does not answer for is left undefined", async () => {
    on("GET /90001", graphError(500, { code: 2 }));
    const ig = await connect();
    expect(await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE })).toEqual({ mediaId: "90001", permalink: undefined });
  });

  test("an image not ready yet is polled, then published once more", async () => {
    on(
      `POST /${IG_ID}/media_publish`,
      graphError(400, { code: 9007, error_subcode: 2207027, message: "Media ID is not available" }),
      Response.json({ id: "90002" }),
    );
    on("GET /1000", Response.json({ status_code: "IN_PROGRESS" }), Response.json({ status_code: "FINISHED" }));
    const ig = await connect();
    const result = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE });
    expect(result.mediaId).toBe("90002");
    expect(statusPolls()).toHaveLength(2);
    expect(calls.filter((call) => call.path.endsWith("/media_publish"))).toHaveLength(2);
  });
});

describe("publishReel", () => {
  test("polls the container until FINISHED, then publishes", async () => {
    on(
      "GET /1000",
      Response.json({ status_code: "IN_PROGRESS" }),
      Response.json({ status_code: "IN_PROGRESS" }),
      Response.json({ status_code: "FINISHED" }),
    );
    const ig = await connect();
    const result = await Instagram.for(ig, FAST).publishReel({
      videoUrl: VIDEO,
      caption: "Reel",
      coverUrl: IMAGE,
      shareToFeed: false,
      thumbOffset: 1500,
    });
    expect(result.mediaId).toBe("90001");
    expect(calls[0]!.form).toEqual({
      media_type: "REELS",
      video_url: VIDEO,
      caption: "Reel",
      cover_url: IMAGE,
      share_to_feed: "false",
      thumb_offset: "1500",
    });
    expect(statusPolls()).toHaveLength(3);
    expect(statusPolls()[0]!.path).toBe("/1000");
  });

  test("waits with backoff, up to the cap", async () => {
    on("GET /1000", ...Array.from({ length: 5 }, () => Response.json({ status_code: "IN_PROGRESS" })), Response.json({ status_code: "FINISHED" }));
    const ig = await connect();
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      delays.push(ms);
      return real(fn, 0);
    }) as typeof setTimeout);
    try {
      await Instagram.for(ig, { pollIntervalMs: 100, maxPollIntervalMs: 300, timeoutMs: 60_000 }).publishReel({ videoUrl: VIDEO });
    } finally {
      spy.mockRestore();
    }
    expect(delays).toEqual([100, 150, 225, 300, 300]);
  });

  test("a container that does not finish in time fails with timeout and its id", async () => {
    on("GET /1000", Response.json({ status_code: "IN_PROGRESS" }));
    const ig = await connect();
    const error = await Instagram.for(ig, { pollIntervalMs: 5, maxPollIntervalMs: 5, timeoutMs: 30 })
      .publishReel({ videoUrl: VIDEO })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(InstagramPublishError);
    expect(error).toMatchObject({ code: "timeout", containerId: "1000" });
    expect(calls.some((call) => call.path.endsWith("/media_publish"))).toBe(false);
  });

  test("a per-call timeoutMs overrides the publisher's", async () => {
    on("GET /1000", Response.json({ status_code: "IN_PROGRESS" }));
    const ig = await connect();
    const error = await Instagram.for(ig, { pollIntervalMs: 5, timeoutMs: 60_000 })
      .publishReel({ videoUrl: VIDEO }, { timeoutMs: 20 })
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "timeout" });
  });

  test("an abort stops the polling and rejects with the signal's reason", async () => {
    on("GET /1000", Response.json({ status_code: "IN_PROGRESS" }));
    const ig = await connect();
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = Instagram.for(ig, { pollIntervalMs: 50, timeoutMs: 60_000 }).publishReel({ videoUrl: VIDEO }, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
    expect(calls.some((call) => call.path.endsWith("/media_publish"))).toBe(false);
  });

  test("an already aborted signal makes no call", async () => {
    const ig = await connect();
    await expect(
      Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  test("a container in ERROR is invalid media, with Instagram's status", async () => {
    on("GET /1000", Response.json({ status_code: "ERROR", status: "Error: Media upload has failed with error code 2207026" }));
    const ig = await connect();
    const error = await Instagram.for(ig, FAST).publishReel({ videoUrl: VIDEO }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "invalid_media", containerId: "1000" });
    expect(error.message).toContain("2207026");
  });

  test("an EXPIRED container fails with expired", async () => {
    on("GET /1000", Response.json({ status_code: "EXPIRED" }));
    const ig = await connect();
    await expect(Instagram.for(ig, FAST).publishReel({ videoUrl: VIDEO })).rejects.toMatchObject({ code: "expired" });
  });
});

describe("publishCarousel", () => {
  test("creates the item containers, waits for videos, then the carousel's", async () => {
    on("GET /1001", Response.json({ status_code: "IN_PROGRESS" }), Response.json({ status_code: "FINISHED" }));
    const ig = await connect();
    const result = await Instagram.for(ig, FAST).publishCarousel({
      items: [{ imageUrl: IMAGE }, { videoUrl: VIDEO }],
      caption: "Two",
    });
    expect(result.mediaId).toBe("90001");
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.form)).toEqual([
      { image_url: IMAGE, is_carousel_item: "true" },
      { media_type: "VIDEO", video_url: VIDEO, is_carousel_item: "true" },
      { media_type: "CAROUSEL", children: "1000,1001", caption: "Two" },
      { creation_id: "1002" },
    ]);
    // The video item twice, the carousel (it holds a video) once; never the image.
    expect(statusPolls().map((call) => call.path)).toEqual(["/1001", "/1001", "/1002"]);
  });

  test("an image-only carousel is not polled", async () => {
    const ig = await connect();
    await Instagram.for(ig, FAST).publishCarousel({ items: [{ imageUrl: IMAGE }, { imageUrl: IMAGE }] });
    expect(statusPolls()).toHaveLength(0);
  });

  test.each([
    [[{ imageUrl: IMAGE }]],
    [Array.from({ length: 11 }, () => ({ imageUrl: IMAGE }))],
    [[{ imageUrl: IMAGE }, { imageUrl: IMAGE, videoUrl: VIDEO }]],
    [[{ imageUrl: IMAGE }, {}]],
  ])("refuses a bad item list before calling Instagram", async (items) => {
    const ig = await connect();
    await expect(
      Instagram.for(ig, FAST).publishCarousel({ items: items as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });
});

describe("publishStory", () => {
  test("an image story is published without polling", async () => {
    const ig = await connect();
    await Instagram.for(ig, FAST).publishStory({ imageUrl: IMAGE });
    expect(calls[0]!.form).toEqual({ media_type: "STORIES", image_url: IMAGE });
    expect(statusPolls()).toHaveLength(0);
  });

  test("a video story waits for its container", async () => {
    const ig = await connect();
    await Instagram.for(ig, FAST).publishStory({ videoUrl: VIDEO });
    expect(calls[0]!.form).toEqual({ media_type: "STORIES", video_url: VIDEO });
    expect(statusPolls()).toHaveLength(1);
  });

  test("takes exactly one of imageUrl and videoUrl", async () => {
    const ig = await connect();
    await expect(Instagram.for(ig).publishStory({ imageUrl: IMAGE, videoUrl: VIDEO } as never)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(Instagram.for(ig).publishStory({} as never)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("publishingLimit and containerStatus", () => {
  test("reads the quota usage", async () => {
    on(
      `GET /${IG_ID}/content_publishing_limit`,
      Response.json({ data: [{ quota_usage: 7, config: { quota_total: 100, quota_duration: 86400 } }] }),
    );
    const ig = await connect();
    expect(await Instagram.for(ig).publishingLimit()).toEqual({
      quotaUsage: 7,
      quotaTotal: 100,
      quotaDurationSeconds: 86400,
      remaining: 93,
    });
    expect(calls[0]!.query.fields).toBe("quota_usage,config");
  });

  test("reads a container's status", async () => {
    on("GET /555", Response.json({ status_code: "IN_PROGRESS", status: "In progress" }));
    const ig = await connect();
    expect(await Instagram.for(ig).containerStatus("555")).toEqual({ id: "555", statusCode: "IN_PROGRESS", status: "In progress" });
    await expect(Instagram.for(ig).containerStatus("../me")).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("errors", () => {
  test.each([
    [graphError(400, { code: 9, error_subcode: 2207042 }), "quota_exceeded"],
    [graphError(400, { code: 4 }), "rate_limited"],
    [graphError(400, { code: 80002 }), "rate_limited"],
    [new Response("", { status: 429 }), "rate_limited"],
    [graphError(400, { code: 10 }), "permission_denied"],
    [graphError(403, { code: 200 }), "permission_denied"],
    [graphError(400, { code: 9004, error_subcode: 2207052 }), "invalid_media"],
    [graphError(400, { code: 36003, error_subcode: 2207009 }), "invalid_media"],
    [graphError(400, { code: 100, error_subcode: 2207010 }), "invalid_input"],
    [graphError(400, { code: 100 }), "graph_error"],
  ])("maps a refused container to its code (%#)", async (answer, code) => {
    on(`POST /${IG_ID}/media`, answer);
    const ig = await connect();
    const error = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE }).catch((caught) => caught);
    expect(error).toBeInstanceOf(InstagramPublishError);
    expect(error.code).toBe(code);
    // Not retried.
    expect(calls).toHaveLength(1);
  });

  test("keeps Graph's codes and status on the error", async () => {
    on(`POST /${IG_ID}/media`, graphError(400, { code: 9004, error_subcode: 2207052, message: "Media download has failed." }));
    const ig = await connect();
    const error = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 400, graphCode: 9004, graphSubcode: 2207052 });
    expect(error.message).toContain("9004/2207052");
    expect(error.message).toContain("Media download has failed.");
  });

  test("a transient error is retried once", async () => {
    on(`POST /${IG_ID}/media`, graphError(500, { code: 2, is_transient: true }), new Response('{"id":"777"}'));
    const ig = await connect();
    const result = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE });
    expect(result.mediaId).toBe("90001");
    expect(calls.filter((call) => call.path.endsWith("/media"))).toHaveLength(2);
    expect(calls.find((call) => call.path.endsWith("/media_publish"))!.form.creation_id).toBe("777");
  });

  test("a second transient error fails with transient", async () => {
    on(`POST /${IG_ID}/media`, graphError(503, { code: 1 }));
    const ig = await connect();
    await expect(Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE })).rejects.toMatchObject({ code: "transient" });
    expect(calls).toHaveLength(2);
  });

  test("a network failure is transient, and carries no URL", async () => {
    manager.fake({
      instagram: () => {
        throw new TypeError(`fetch failed: https://graph.instagram.com/x?access_token=${TOKEN}`);
      },
    });
    const ig = await connect();
    const error = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "transient" });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(TOKEN);
  });

  test("a transient media_publish failure is retried only while the container reads FINISHED", async () => {
    on(`POST /${IG_ID}/media_publish`, graphError(500, { code: 2 }), Response.json({ id: "90003" }));
    const ig = await connect();
    const result = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE });
    expect(result.mediaId).toBe("90003");
    expect(statusPolls()).toHaveLength(1);
  });

  test("a transient media_publish failure on a PUBLISHED container is unconfirmed, not retried", async () => {
    on(`POST /${IG_ID}/media_publish`, graphError(500, { code: 2 }));
    on("GET /1000", Response.json({ status_code: "PUBLISHED" }));
    const ig = await connect();
    const error = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "unconfirmed", containerId: "1000" });
    expect(calls.filter((call) => call.path.endsWith("/media_publish"))).toHaveLength(1);
  });

  test("never puts the token in a message", async () => {
    on(
      `POST /${IG_ID}/media`,
      graphError(400, { code: 100, message: `Invalid parameter access_token=${TOKEN} for ${TOKEN}` }),
    );
    const ig = await connect();
    const error = await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE }).catch((caught) => caught);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[redacted]");
  });

  test("a token still refused after a refresh is reconnect_required", async () => {
    // Faked connections skip the refresh and retry with the same token.
    on(`POST /${IG_ID}/media`, graphError(400, { code: 190 }));
    const ig = await connect();
    await expect(Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE })).rejects.toMatchObject({
      code: "reconnect_required",
    });
  });

  test("a dead token marks the connection and throws OAuthReconnectRequiredError", async () => {
    manager.restore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => graphError(400, { code: 190, message: "Error validating access token" })),
    );
    // Issued just now: too young to renew, so the refused token means the grant is gone.
    const ig = await connect();
    await expect(Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE })).rejects.toBeInstanceOf(
      OAuthReconnectRequiredError,
    );
    expect((await manager.for("user-1", "instagram", IG_ID))!.status).toBe("needs_reconnect");
  });
});

describe("validation", () => {
  test.each([
    [{ imageUrl: "http://cdn.example.com/a.jpg" }, "https"],
    [{ imageUrl: "/uploads/a.jpg" }, "absolute"],
    [{ imageUrl: "https://localhost/a.jpg" }, "public"],
    [{ imageUrl: "https://127.0.0.1/a.jpg" }, "public"],
    [{ imageUrl: "https://10.0.0.4/a.jpg" }, "public"],
    [{ imageUrl: "https://[::1]/a.jpg" }, "public"],
    [{ imageUrl: "https://minio/a.jpg" }, "public"],
    [{ imageUrl: "https://files.internal/a.jpg" }, "public"],
    [{ imageUrl: IMAGE, caption: "x".repeat(2201) }, "2200"],
    [{ imageUrl: IMAGE, caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ") }, "30 hashtags"],
    [{ imageUrl: IMAGE, caption: Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" ") }, "20 @mentions"],
    [{ imageUrl: IMAGE, userTags: [{ username: "a", x: 1.5, y: 0 }] }, "between 0 and 1"],
    [{ imageUrl: IMAGE, userTags: Array.from({ length: 21 }, () => ({ username: "a", x: 0, y: 0 })) }, "20 tags"],
  ])("refuses %j before calling Instagram", async (post, message) => {
    const ig = await connect();
    const error = await Instagram.for(ig).publishImage(post).catch((caught) => caught);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(error.message).toContain(message);
    expect(calls).toHaveLength(0);
  });

  test("accepts a caption at the limits", async () => {
    const ig = await connect();
    const caption = `${Array.from({ length: 30 }, (_, i) => `#t${i}`).join(" ")} me@example.com`;
    await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE, caption });
    await Instagram.for(ig, FAST).publishImage({ imageUrl: IMAGE, caption: "é".repeat(2200) });
    expect(calls.filter((call) => call.path.endsWith("/media_publish"))).toHaveLength(2);
  });

  test("refuses a bad reel thumbOffset", async () => {
    const ig = await connect();
    await expect(Instagram.for(ig).publishReel({ videoUrl: VIDEO, thumbOffset: -1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(Instagram.for(ig).publishReel({ videoUrl: VIDEO, thumbOffset: 1.5 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("a connection without instagram_business_content_publish is refused", async () => {
    const ig = await connect(["instagram_business_basic"]);
    await expect(Instagram.for(ig).publishImage({ imageUrl: IMAGE })).rejects.toMatchObject({ code: "permission_denied" });
    expect(calls).toHaveLength(0);
  });

  test("only takes an Instagram connection", async () => {
    const figma = await manager.save("user-1", "figma", { accessToken: "t" });
    expect(() => Instagram.for(figma)).toThrow(TypeError);
  });
});
