/**
 * Channel names: patterns, the topics they build, and the checks both go
 * through. Shared by the `Broadcast` facade (which builds the topic an emit
 * goes to), `ChannelRouter` (which builds the topic a socket may join) and the
 * fake (which matches a pattern against recorded topics), so the three can
 * never disagree on what `site.:siteId` with `{ siteId: "abc" }` is called.
 *
 * A pattern is dot-separated segments, each either a literal (`site`) or a
 * param (`:siteId`). A topic is the same with every param filled in:
 * `site.abc123`. Param values are restricted to `[A-Za-z0-9_-]`, so a value
 * can never contain a dot and add a segment, and a topic can always be read
 * back as exactly one pattern's.
 */

/** The longest topic, in characters. */
export const MAX_TOPIC_LENGTH = 255;

/** The longest event name, in characters. */
export const MAX_EVENT_NAME_LENGTH = 64;

const LITERAL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const PARAM_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]+$/;

/** The names of a pattern's params: `"site.:siteId"` → `"siteId"`. */
export type ChannelParamNames<P extends string> = P extends `${infer Head}.${infer Rest}`
  ? SegmentParam<Head> | ChannelParamNames<Rest>
  : SegmentParam<P>;

type SegmentParam<S extends string> = S extends `:${infer Name}` ? Name : never;

/** The params a pattern takes: `"site.:siteId"` → `{ siteId: string | number }`. */
export type ChannelParams<P extends string> = {
  [K in ChannelParamNames<P>]: string | number;
};

/**
 * `[]` for a pattern without params (or a concrete topic), `[params]` for one
 * with them, so `Broadcast.to("status")` and `Broadcast.to("site.:siteId",
 * { siteId })` both type-check and `Broadcast.to("site.:siteId")` does not.
 */
export type ChannelParamsArgs<P extends string> = [ChannelParamNames<P>] extends [never]
  ? [params?: Record<string, never>]
  : [params: ChannelParams<P>];

/**
 * A resolved channel: the topic sockets subscribe to, and the pattern it came
 * from when it was built from one. What `BroadcastEvent.channel()` returns and
 * `Broadcast.to()` accepts.
 */
export interface ChannelTarget {
  readonly topic: string;
  readonly pattern?: string;
}

/** A pattern, topic or param was refused. The message says which and why. */
export class InvalidChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChannelError";
  }
}

/** Whether `value` is a `ChannelTarget` rather than a pattern string. */
export function isChannelTarget(value: unknown): value is ChannelTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { topic?: unknown }).topic === "string"
  );
}

/** The segments of a pattern, checked. Throws `InvalidChannelError`. */
export function parsePattern(pattern: string): string[] {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new InvalidChannelError("A channel pattern must be a non-empty string.");
  }
  if (pattern.length > MAX_TOPIC_LENGTH) {
    throw new InvalidChannelError(
      `The channel pattern "${pattern.slice(0, 40)}…" is longer than ${MAX_TOPIC_LENGTH} characters.`,
    );
  }
  const segments = pattern.split(".");
  const seen = new Set<string>();
  for (const segment of segments) {
    if (PARAM_SEGMENT.test(segment)) {
      const name = segment.slice(1);
      if (seen.has(name)) {
        throw new InvalidChannelError(
          `The channel pattern "${pattern}" names the param "${name}" twice.`,
        );
      }
      seen.add(name);
      continue;
    }
    if (segment.startsWith("__")) {
      throw new InvalidChannelError(
        `The channel "${pattern}" has the segment "${segment}". Segments starting ` +
          `with "__" are reserved for gemi (driver control messages).`,
      );
    }
    if (!LITERAL_SEGMENT.test(segment)) {
      throw new InvalidChannelError(
        `The channel pattern "${pattern}" has an invalid segment "${segment}". ` +
          `Segments are separated by dots and are either letters, digits, "_" ` +
          `and "-", or a param such as ":siteId".`,
      );
    }
  }
  return segments;
}

/** The param names of a pattern, in order. */
export function patternParams(pattern: string): string[] {
  return parsePattern(pattern)
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/**
 * The topic `pattern` names with `params` filled in. Every param must be
 * given, and nothing else: a missing one, an extra one, or a value outside
 * `[A-Za-z0-9_-]` throws `InvalidChannelError`, so a client can never steer a
 * subscription onto a topic its pattern does not describe.
 */
export function buildTopic(pattern: string, params: Record<string, unknown> = {}): string {
  const segments = parsePattern(pattern);
  const expected = new Set<string>();
  const topic = segments
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      expected.add(name);
      const value = params[name];
      if (value === undefined || value === null) {
        throw new InvalidChannelError(`The channel "${pattern}" needs the param "${name}".`);
      }
      const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
      if (typeof text !== "string" || !PARAM_VALUE.test(text)) {
        throw new InvalidChannelError(
          `The param "${name}" of the channel "${pattern}" must be 1 to 128 ` +
            `letters, digits, "_" or "-". Use a public id in a channel name.`,
        );
      }
      return text;
    })
    .join(".");

  for (const key of Object.keys(params)) {
    if (!expected.has(key)) {
      throw new InvalidChannelError(`The channel "${pattern}" has no param "${key}".`);
    }
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    throw new InvalidChannelError(
      `The topic built from "${pattern}" is longer than ${MAX_TOPIC_LENGTH} characters.`,
    );
  }
  return topic;
}

/** Checks a concrete topic (no params). Throws `InvalidChannelError`. */
export function assertTopic(topic: string): string {
  const segments = parsePattern(topic);
  if (segments.some((segment) => segment.startsWith(":"))) {
    throw new InvalidChannelError(
      `"${topic}" is a pattern, not a topic: pass its params, as in ` +
        `Broadcast.to("${topic}", { ... }).`,
    );
  }
  return topic;
}

/** Checks an event name. Throws `InvalidChannelError`. */
export function assertEventName(event: string): string {
  if (
    typeof event !== "string" ||
    event.length === 0 ||
    event.length > MAX_EVENT_NAME_LENGTH ||
    !EVENT_NAME.test(event)
  ) {
    throw new InvalidChannelError(
      `The event name "${String(event).slice(0, 40)}" must be 1 to ` +
        `${MAX_EVENT_NAME_LENGTH} letters, digits, "_", "-", "." or ":".`,
    );
  }
  return event;
}

/**
 * Whether `topic` is one `pattern` builds. A pattern without params matches
 * only itself, except `"user"`, which also matches every `user.<id>`: that is
 * the topic the router's `user` channel resolves to.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === USER_CHANNEL)
    return topic.startsWith(`${USER_CHANNEL}.`) && topic.split(".").length === 2;
  const patternSegments = pattern.split(".");
  const topicSegments = topic.split(".");
  if (patternSegments.length !== topicSegments.length) return false;
  return patternSegments.every(
    (segment, i) =>
      segment === topicSegments[i] ||
      (segment.startsWith(":") && PARAM_VALUE.test(topicSegments[i])),
  );
}

/**
 * The channel `ChannelRouter` resolves from the session rather than from
 * params: a socket that subscribes to `"user"` joins `user.<its user's id>`.
 */
export const USER_CHANNEL = "user";

/** The topic of a user's own channel. */
export function userTopic(user: { id: unknown } | string | number): string {
  const id = typeof user === "object" && user !== null ? user.id : user;
  return buildTopic(`${USER_CHANNEL}.:id`, { id: id as string | number });
}
