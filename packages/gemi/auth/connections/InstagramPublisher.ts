import { classifyAddress, parseAddress } from "../../http/safeFetch/addresses";
import { parseInstagramJson } from "../oauth/instagram";
import type { ProviderConnection } from "./ConnectionManager";
import { InstagramConnectionProvider } from "./InstagramConnectionProvider";

/**
 * Content publishing for an Instagram connection (#1117), over
 * `connection.fetch`: a media container, waiting for it when it holds video,
 * then `media_publish`.
 *
 * ```ts
 * const ig = await Connections.for(user, "instagram", igAccountId);
 * const { mediaId, permalink } = await Instagram.for(ig).publishImage({ imageUrl, caption });
 * ```
 *
 * The token handling is `connection.fetch`'s: the token goes to
 * `graph.instagram.com` only, renews when close to expiring, and a dead one
 * marks the connection and throws `OAuthReconnectRequiredError`.
 */

/** Why a publish failed. See `InstagramPublishError`. */
export type InstagramPublishErrorCode =
  | "invalid_input"
  | "permission_denied"
  | "rate_limited"
  | "quota_exceeded"
  | "invalid_media"
  | "expired"
  | "reconnect_required"
  | "transient"
  | "unconfirmed"
  | "timeout"
  | "graph_error";

/**
 * A publish Instagram refused, or one refused before asking it. The message
 * has the HTTP status, Graph's error codes and Graph's message with anything
 * token-like removed; never a URL or a token.
 */
export class InstagramPublishError extends Error {
  readonly status?: number;
  /** Graph's `error.code`. */
  readonly graphCode?: number;
  /** Graph's `error.error_subcode`. */
  readonly graphSubcode?: number;
  /** The media container concerned, when there is one: `timeout` leaves it processing. */
  readonly containerId?: string;

  constructor(
    readonly code: InstagramPublishErrorCode,
    message: string,
    options: { status?: number; graphCode?: number; graphSubcode?: number; containerId?: string } = {},
  ) {
    super(message);
    this.name = "InstagramPublishError";
    this.status = options.status;
    this.graphCode = options.graphCode;
    this.graphSubcode = options.graphSubcode;
    this.containerId = options.containerId;
  }
}

export interface InstagramPublisherOptions {
  /**
   * The Graph API version, such as `"v25.0"`. Default: the connection
   * provider's `graphApiVersion`, else the unversioned path (the app's
   * default version), as `/me` does.
   */
  graphApiVersion?: string;
  /** First wait between container status checks. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Longest wait between checks; each wait is 1.5 times the last. Default 10000 ms. */
  maxPollIntervalMs?: number;
  /** How long a container may take to finish. Default 300000 ms (5 minutes). */
  timeoutMs?: number;
}

/** Per call. */
export interface InstagramPublishOptions {
  /** Stops waiting and calling; the call rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Overrides the publisher's `timeoutMs` for this call. */
  timeoutMs?: number;
}

export interface InstagramUserTag {
  username: string;
  /** 0 (left) to 1 (right). */
  x: number;
  /** 0 (top) to 1 (bottom). */
  y: number;
}

export interface InstagramImagePost {
  /** A public https URL Instagram fetches the JPEG from. */
  imageUrl: string;
  caption?: string;
  altText?: string;
  userTags?: InstagramUserTag[];
  /** A Facebook Page's location id. */
  locationId?: string;
}

export type InstagramCarouselItem = { imageUrl: string; videoUrl?: never } | { videoUrl: string; imageUrl?: never };

export interface InstagramCarouselPost {
  /** 2 to 10 images and videos. */
  items: InstagramCarouselItem[];
  caption?: string;
}

export interface InstagramReelPost {
  videoUrl: string;
  caption?: string;
  /** A public https URL of the cover image. */
  coverUrl?: string;
  /** Show the reel in the feed as well as in Reels. Instagram's default is true. */
  shareToFeed?: boolean;
  /** The frame used as the thumbnail, in milliseconds from the start (ignored with `coverUrl`). */
  thumbOffset?: number;
}

export type InstagramStoryPost = { imageUrl: string; videoUrl?: never } | { videoUrl: string; imageUrl?: never };

export interface InstagramPublished {
  /** The published media's id. */
  mediaId: string;
  /** The post's URL; undefined when Instagram did not answer for it. */
  permalink?: string;
}

export interface InstagramPublishingLimit {
  /** Posts published in the current window. */
  quotaUsage: number;
  /** Posts allowed per window (100). */
  quotaTotal: number;
  /** The window, in seconds (86400). */
  quotaDurationSeconds: number;
  /** `quotaTotal - quotaUsage`, at least 0. */
  remaining: number;
}

export type InstagramContainerStatusCode = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export interface InstagramContainerStatus {
  id: string;
  statusCode: InstagramContainerStatusCode;
  /** Instagram's detail, such as `"Error: Media upload has failed with error code 2207026"`. */
  status?: string;
}

/** Limits Instagram documents for content publishing. */
export const INSTAGRAM_LIMITS = {
  captionLength: 2200,
  hashtags: 30,
  mentions: 20,
  userTags: 20,
  carouselMin: 2,
  carouselMax: 10,
} as const;

const PUBLISH_SCOPE = "instagram_business_content_publish";

export const Instagram = {
  /**
   * A publisher for an Instagram connection (`InstagramConnectionProvider`)
   * that granted `instagram_business_content_publish`.
   */
  for(connection: ProviderConnection, options: InstagramPublisherOptions = {}): InstagramPublisher {
    return new InstagramPublisher(connection, options);
  },
};

export class InstagramPublisher {
  private readonly version: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(
    readonly connection: ProviderConnection,
    options: InstagramPublisherOptions = {},
  ) {
    const provider = connection.connectionProvider();
    if (!(provider instanceof InstagramConnectionProvider)) {
      throw new TypeError(
        `Instagram.for() takes an Instagram connection; "${connection.provider}" is not an InstagramConnectionProvider.`,
      );
    }
    const version = options.graphApiVersion ?? provider.instagram.graphApiVersion;
    this.version = version ? `/${version.replace(/^\/+|\/+$/g, "")}` : "";
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  /** One image to the feed. */
  async publishImage(post: InstagramImagePost, options: InstagramPublishOptions = {}): Promise<InstagramPublished> {
    validateUrl("imageUrl", post.imageUrl);
    validateCaption(post.caption);
    if (post.altText !== undefined && typeof post.altText !== "string") invalid("altText must be a string.");
    if (post.userTags !== undefined) validateUserTags(post.userTags);
    const context = this.start(options);
    const container = await this.createContainer(
      {
        image_url: post.imageUrl,
        caption: post.caption,
        alt_text: post.altText,
        user_tags: post.userTags ? JSON.stringify(post.userTags) : undefined,
        location_id: post.locationId,
      },
      context,
    );
    return this.publishContainer(container, false, context);
  }

  /** 2 to 10 images and videos as one post: a container per item, then the carousel's. */
  async publishCarousel(post: InstagramCarouselPost, options: InstagramPublishOptions = {}): Promise<InstagramPublished> {
    const items = post.items;
    if (!Array.isArray(items) || items.length < INSTAGRAM_LIMITS.carouselMin || items.length > INSTAGRAM_LIMITS.carouselMax) {
      invalid(`A carousel takes ${INSTAGRAM_LIMITS.carouselMin} to ${INSTAGRAM_LIMITS.carouselMax} items.`);
    }
    items.forEach((item, at) => validateOneMedia(`items[${at}]`, item));
    validateCaption(post.caption);
    const context = this.start(options);

    const children: string[] = [];
    for (const item of items) {
      const id = await this.createContainer(
        item.videoUrl !== undefined
          ? { media_type: "VIDEO", video_url: item.videoUrl, is_carousel_item: "true" }
          : { image_url: item.imageUrl, is_carousel_item: "true" },
        context,
      );
      if (item.videoUrl !== undefined) await this.waitUntilFinished(id, context);
      children.push(id);
    }
    const hasVideo = items.some((item) => item.videoUrl !== undefined);
    const container = await this.createContainer(
      { media_type: "CAROUSEL", children: children.join(","), caption: post.caption },
      context,
    );
    return this.publishContainer(container, hasVideo, context);
  }

  /** A reel. Waits for Instagram to process the video. */
  async publishReel(post: InstagramReelPost, options: InstagramPublishOptions = {}): Promise<InstagramPublished> {
    validateUrl("videoUrl", post.videoUrl);
    if (post.coverUrl !== undefined) validateUrl("coverUrl", post.coverUrl);
    validateCaption(post.caption);
    if (post.thumbOffset !== undefined && !(Number.isInteger(post.thumbOffset) && post.thumbOffset >= 0)) {
      invalid("thumbOffset must be a whole number of milliseconds, 0 or more.");
    }
    const context = this.start(options);
    const container = await this.createContainer(
      {
        media_type: "REELS",
        video_url: post.videoUrl,
        caption: post.caption,
        cover_url: post.coverUrl,
        share_to_feed: post.shareToFeed === undefined ? undefined : String(post.shareToFeed),
        thumb_offset: post.thumbOffset === undefined ? undefined : String(post.thumbOffset),
      },
      context,
    );
    return this.publishContainer(container, true, context);
  }

  /** A story: one image or one video. */
  async publishStory(post: InstagramStoryPost, options: InstagramPublishOptions = {}): Promise<InstagramPublished> {
    validateOneMedia("story", post);
    const context = this.start(options);
    const video = post.videoUrl !== undefined;
    const container = await this.createContainer(
      video
        ? { media_type: "STORIES", video_url: post.videoUrl }
        : { media_type: "STORIES", image_url: post.imageUrl },
      context,
    );
    return this.publishContainer(container, video, context);
  }

  /** The account's use of the publishing limit (100 posts per 24 hours). */
  async publishingLimit(options: Pick<InstagramPublishOptions, "signal"> = {}): Promise<InstagramPublishingLimit> {
    const context = this.start(options);
    const payload = await this.call(
      "publishing limit request",
      `/${this.accountId()}/content_publishing_limit?fields=quota_usage,config`,
      undefined,
      context,
    );
    const entry = (Array.isArray(payload.data) ? payload.data[0] : payload) as Record<string, unknown> | undefined;
    const config = (entry?.config ?? {}) as Record<string, unknown>;
    const quotaUsage = numberOr(entry?.quota_usage, 0);
    const quotaTotal = numberOr(config.quota_total, 100);
    return {
      quotaUsage,
      quotaTotal,
      quotaDurationSeconds: numberOr(config.quota_duration, 86_400),
      remaining: Math.max(0, quotaTotal - quotaUsage),
    };
  }

  /** A media container's processing status. */
  async containerStatus(id: string, options: Pick<InstagramPublishOptions, "signal"> = {}): Promise<InstagramContainerStatus> {
    return this.readStatus(id, this.start(options));
  }

  // --- internals ---------------------------------------------------------------

  private start(options: InstagramPublishOptions): Context {
    options.signal?.throwIfAborted();
    if (!this.connection.hasScopes(PUBLISH_SCOPE)) {
      throw new InstagramPublishError(
        "permission_denied",
        `The Instagram connection was not granted ${PUBLISH_SCOPE}; connect it again with that scope.`,
      );
    }
    return { signal: options.signal, deadline: Date.now() + (options.timeoutMs ?? this.timeoutMs) };
  }

  private accountId(): string {
    const id = this.connection.providerAccountId;
    if (!id) {
      throw new InstagramPublishError("invalid_input", "The Instagram connection has no account id (providerAccountId).");
    }
    return id;
  }

  private async createContainer(fields: Record<string, string | undefined>, context: Context): Promise<string> {
    const payload = await this.call("media container request", `/${this.accountId()}/media`, fields, context);
    return requireId(payload, "media container request");
  }

  private async publishContainer(containerId: string, wait: boolean, context: Context): Promise<InstagramPublished> {
    try {
      if (wait) await this.waitUntilFinished(containerId, context);
      const mediaId = await this.publishOnce(containerId, wait, context);
      return { mediaId, permalink: await this.permalink(mediaId, context) };
    } catch (error) {
      throw error instanceof InstagramPublishError ? withContainer(error, containerId) : error;
    }
  }

  /**
   * `media_publish`, retried at most once: after a transient failure only
   * when the container still reads FINISHED (retrying blindly could post
   * twice), and after "not ready" once the container has finished.
   */
  private async publishOnce(containerId: string, waited: boolean, context: Context): Promise<string> {
    try {
      return await this.mediaPublish(containerId, context);
    } catch (error) {
      if (!(error instanceof InstagramPublishError)) throw error;
      if (error.code === "transient") {
        const { statusCode } = await this.readStatus(containerId, context);
        if (statusCode === "PUBLISHED") {
          throw new InstagramPublishError(
            "unconfirmed",
            "Instagram's media_publish failed, but the container reads PUBLISHED: the post is probably live. Do not publish it again.",
            { status: error.status, graphCode: error.graphCode, graphSubcode: error.graphSubcode },
          );
        }
        if (statusCode !== "FINISHED") throw error;
        return this.mediaPublish(containerId, context);
      }
      if (isNotReady(error) && !waited) {
        await this.waitUntilFinished(containerId, context);
        return this.mediaPublish(containerId, context);
      }
      throw error;
    }
  }

  private async mediaPublish(containerId: string, context: Context): Promise<string> {
    const payload = await this.call(
      "media_publish request",
      `/${this.accountId()}/media_publish`,
      { creation_id: containerId },
      context,
      { retry: false },
    );
    return requireId(payload, "media_publish request");
  }

  private async permalink(mediaId: string, context: Context): Promise<string | undefined> {
    try {
      const payload = await this.call("permalink request", `/${mediaId}?fields=permalink`, undefined, context, { retry: false });
      return typeof payload.permalink === "string" ? payload.permalink : undefined;
    } catch (error) {
      if (error instanceof InstagramPublishError) return undefined;
      throw error;
    }
  }

  private async readStatus(id: string, context: Context): Promise<InstagramContainerStatus> {
    if (!/^\d+$/.test(id)) invalid("A container id is a string of digits.");
    const payload = await this.call("container status request", `/${id}?fields=status_code,status`, undefined, context);
    const statusCode = payload.status_code;
    if (typeof statusCode !== "string" || !STATUS_CODES.has(statusCode)) {
      throw new InstagramPublishError("graph_error", "Instagram's container status answered without a known status_code.", {
        status: 200,
        containerId: id,
      });
    }
    const result: InstagramContainerStatus = { id, statusCode: statusCode as InstagramContainerStatusCode };
    if (typeof payload.status === "string" && payload.status !== "") result.status = scrub(payload.status);
    return result;
  }

  private async waitUntilFinished(id: string, context: Context): Promise<void> {
    let interval = this.pollIntervalMs;
    for (;;) {
      const { statusCode, status } = await this.readStatus(id, context);
      if (statusCode === "FINISHED") return;
      if (statusCode === "PUBLISHED") {
        throw new InstagramPublishError("invalid_input", "That media container has been published already.", { containerId: id });
      }
      if (statusCode === "ERROR") {
        throw new InstagramPublishError(
          "invalid_media",
          `Instagram could not process the media${status ? ` (${status})` : ""}.`,
          { containerId: id },
        );
      }
      if (statusCode === "EXPIRED") {
        throw new InstagramPublishError("expired", "The media container expired before it was published.", { containerId: id });
      }
      const left = context.deadline - Date.now();
      if (left <= 0) {
        throw new InstagramPublishError(
          "timeout",
          "Instagram had not finished processing the media in time; the container is still processing.",
          { containerId: id },
        );
      }
      await sleep(Math.min(interval, left), context.signal);
      interval = Math.min(interval * 1.5, this.maxPollIntervalMs);
    }
  }

  /**
   * One Graph call, retried once when Instagram says the failure is transient
   * (unless `retry: false`). Errors become `InstagramPublishError`; the
   * connection's own errors (`OAuthReconnectRequiredError`) and an abort pass
   * through.
   */
  private async call(
    what: string,
    path: string,
    form: Record<string, string | undefined> | undefined,
    context: Context,
    { retry = true }: { retry?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    try {
      return await this.callOnce(what, path, form, context);
    } catch (error) {
      if (!retry || !(error instanceof InstagramPublishError) || error.code !== "transient") throw error;
      return this.callOnce(what, path, form, context);
    }
  }

  private async callOnce(
    what: string,
    path: string,
    form: Record<string, string | undefined> | undefined,
    context: Context,
  ): Promise<Record<string, unknown>> {
    context.signal?.throwIfAborted();
    const init: RequestInit = { method: form ? "POST" : "GET", signal: context.signal };
    if (form) {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) if (value !== undefined) body.set(key, value);
      init.body = body;
    }
    let response: Response;
    try {
      response = await this.connection.fetch(`${this.version}${path}`, init);
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      // Not attached as `cause`: a network error can carry the request URL,
      // and the URL carries the token.
      if (error instanceof TypeError) {
        throw new InstagramPublishError("transient", `Instagram's ${what} failed to reach Instagram.`);
      }
      throw error;
    }
    const payload = parseInstagramJson(await response.text().catch(() => ""));
    if (response.ok) return payload;
    throw graphError(what, response.status, payload);
  }
}

interface Context {
  signal?: AbortSignal;
  deadline: number;
}

const STATUS_CODES = new Set(["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"]);

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const PERMISSION_CODES = new Set([3, 10]);
const INVALID_MEDIA_CODES = new Set([9004, 352, 36000, 36001, 36002, 36003, 36004]);
const INVALID_MEDIA_SUBCODES = new Set([2207004, 2207005, 2207006, 2207009, 2207023, 2207026, 2207028, 2207052]);
const TOKEN_CODES = new Set([102, 190, 463, 467]);
const TRANSIENT_SUBCODES = new Set([2207001, 2207003, 2207053]);
/** "Media ID is not available": the container is still processing. */
const NOT_READY = { code: 9007, subcode: 2207027 };

function graphError(what: string, status: number, payload: Record<string, unknown>): InstagramPublishError {
  const error = (payload.error ?? {}) as Record<string, unknown>;
  const graphCode = finite(error.code);
  const graphSubcode = finite(error.error_subcode);
  const type = typeof error.type === "string" && error.type !== "" ? error.type : undefined;
  const detail = typeof error.message === "string" && error.message !== "" ? `: ${scrub(error.message)}` : "";
  const codes = [graphCode, graphSubcode].filter((value) => value !== undefined).join("/");
  const message = `Instagram refused the ${what} (HTTP ${status}${type ? `, ${type}` : ""}${codes ? ` ${codes}` : ""})${detail}`;

  let code: InstagramPublishErrorCode = "graph_error";
  if (graphSubcode === 2207042) code = "quota_exceeded";
  else if (graphSubcode === 2207010) code = "invalid_input";
  else if (graphCode !== undefined && RATE_LIMIT_CODES.has(graphCode)) code = "rate_limited";
  else if (graphCode !== undefined && TOKEN_CODES.has(graphCode)) code = "reconnect_required";
  else if (graphCode !== undefined && (PERMISSION_CODES.has(graphCode) || (graphCode >= 200 && graphCode <= 299)))
    code = "permission_denied";
  else if (
    (graphCode !== undefined && INVALID_MEDIA_CODES.has(graphCode)) ||
    (graphSubcode !== undefined && INVALID_MEDIA_SUBCODES.has(graphSubcode))
  )
    code = "invalid_media";
  else if (
    error.is_transient === true ||
    graphCode === 1 ||
    graphCode === 2 ||
    (graphSubcode !== undefined && TRANSIENT_SUBCODES.has(graphSubcode)) ||
    status >= 500 ||
    status === 429
  )
    code = status === 429 ? "rate_limited" : "transient";

  return new InstagramPublishError(code, message, { status, graphCode, graphSubcode });
}

function isNotReady(error: InstagramPublishError): boolean {
  return error.graphCode === NOT_READY.code || error.graphSubcode === NOT_READY.subcode;
}

function withContainer(error: InstagramPublishError, containerId: string): InstagramPublishError {
  if (error.containerId) return error;
  return new InstagramPublishError(error.code, error.message, {
    status: error.status,
    graphCode: error.graphCode,
    graphSubcode: error.graphSubcode,
    containerId,
  });
}

/** Removes anything that could be a token from text Instagram sent back. */
function scrub(text: string): string {
  return text
    .replace(/access_token=[^&\s"']*/gi, "access_token=[redacted]")
    .replace(/\b(?:IG|EAA)[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .slice(0, 500);
}

function requireId(payload: Record<string, unknown>, what: string): string {
  const id = payload.id;
  if (typeof id === "string" && id !== "") return id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  throw new InstagramPublishError("graph_error", `Instagram's ${what} answered without an id.`, { status: 200 });
}

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) ? number : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) ? number : fallback;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// --- validation ------------------------------------------------------------------

function invalid(message: string): never {
  throw new InstagramPublishError("invalid_input", message);
}

function validateCaption(caption: string | undefined): void {
  if (caption === undefined) return;
  if (typeof caption !== "string") invalid("caption must be a string.");
  if ([...caption].length > INSTAGRAM_LIMITS.captionLength) {
    invalid(`A caption takes at most ${INSTAGRAM_LIMITS.captionLength} characters.`);
  }
  if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > INSTAGRAM_LIMITS.hashtags) {
    invalid(`A caption takes at most ${INSTAGRAM_LIMITS.hashtags} hashtags.`);
  }
  if ((caption.match(/(?<![\p{L}\p{N}_.@])@[\p{L}\p{N}_.]+/gu) ?? []).length > INSTAGRAM_LIMITS.mentions) {
    invalid(`A caption takes at most ${INSTAGRAM_LIMITS.mentions} @mentions.`);
  }
}

function validateUserTags(tags: InstagramUserTag[]): void {
  if (!Array.isArray(tags) || tags.length > INSTAGRAM_LIMITS.userTags) {
    invalid(`userTags takes at most ${INSTAGRAM_LIMITS.userTags} tags.`);
  }
  for (const tag of tags) {
    const inRange = (value: unknown) => typeof value === "number" && value >= 0 && value <= 1;
    if (typeof tag?.username !== "string" || tag.username === "" || !inRange(tag.x) || !inRange(tag.y)) {
      invalid("Each user tag needs a username, and x and y between 0 and 1.");
    }
  }
}

function validateOneMedia(label: string, item: { imageUrl?: string; videoUrl?: string } | undefined): void {
  const image = item?.imageUrl !== undefined;
  const video = item?.videoUrl !== undefined;
  if (image === video) invalid(`${label} takes exactly one of imageUrl and videoUrl.`);
  if (image) validateUrl(`${label}.imageUrl`, item!.imageUrl!);
  else validateUrl(`${label}.videoUrl`, item!.videoUrl!);
}

/**
 * Instagram fetches the media itself, so the URL must be https and reachable
 * from the internet: not localhost, a single-label or `.local`/`.internal`
 * host, or a private IP address.
 */
function validateUrl(label: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${label} is not an absolute URL.`);
  }
  if (url.protocol !== "https:") invalid(`${label} must be an https URL: Instagram fetches the media from it.`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const address = parseAddress(host);
  const internal = address
    ? classifyAddress(address) !== null
    : !host.includes(".") || /(^|\.)(localhost|local|internal)$/.test(host);
  if (internal) invalid(`${label} must be a public URL: Instagram fetches the media from it.`);
}
