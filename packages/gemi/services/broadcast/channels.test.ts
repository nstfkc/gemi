import { describe, expect, test } from "vitest";

import {
  assertEventName,
  assertTopic,
  buildTopic,
  InvalidChannelError,
  parsePattern,
  patternParams,
  topicMatches,
  userTopic,
} from "./channels";

describe("buildTopic", () => {
  test("fills each param in", () => {
    expect(buildTopic("site.:siteId", { siteId: "abc123" })).toBe("site.abc123");
    expect(buildTopic("org.:orgId.page.:pageId", { orgId: 7, pageId: "p-1_x" })).toBe(
      "org.7.page.p-1_x",
    );
    expect(buildTopic("status")).toBe("status");
  });

  test("refuses a missing param, an extra one, and a value that could add a segment", () => {
    expect(() => buildTopic("site.:siteId", {})).toThrow(InvalidChannelError);
    expect(() => buildTopic("site.:siteId", { siteId: "a", other: "b" })).toThrow(
      /no param "other"/,
    );
    expect(() => buildTopic("site.:siteId", { siteId: "a.b" })).toThrow(InvalidChannelError);
    expect(() => buildTopic("site.:siteId", { siteId: "*" })).toThrow(InvalidChannelError);
    expect(() => buildTopic("site.:siteId", { siteId: "" })).toThrow(InvalidChannelError);
    expect(() => buildTopic("site.:siteId", { siteId: { id: 1 } })).toThrow(InvalidChannelError);
    expect(() => buildTopic("site.:siteId", { siteId: Number.NaN })).toThrow(InvalidChannelError);
    expect(() => buildTopic("site.:siteId", { siteId: "x".repeat(129) })).toThrow(
      InvalidChannelError,
    );
  });
});

describe("parsePattern", () => {
  test("accepts literals and params", () => {
    expect(parsePattern("site.:siteId.pages")).toEqual(["site", ":siteId", "pages"]);
    expect(patternParams("a.:x.b.:y")).toEqual(["x", "y"]);
  });

  test("refuses empty segments, wildcards, and a param named twice", () => {
    for (const bad of ["", "site.", ".site", "site..x", "site.*", "site.:", "a b", ":x.:x"]) {
      expect(() => parsePattern(bad), bad).toThrow(InvalidChannelError);
    }
  });
});

test("assertTopic refuses a pattern", () => {
  expect(assertTopic("site.abc")).toBe("site.abc");
  expect(() => assertTopic("site.:siteId")).toThrow(/is a pattern, not a topic/);
});

test("assertEventName", () => {
  expect(assertEventName("changed")).toBe("changed");
  expect(assertEventName("page:built.v2")).toBe("page:built.v2");
  expect(() => assertEventName("")).toThrow(InvalidChannelError);
  expect(() => assertEventName("has space")).toThrow(InvalidChannelError);
  expect(() => assertEventName("x".repeat(65))).toThrow(InvalidChannelError);
});

describe("topicMatches", () => {
  test("a pattern matches the topics it builds, and only those", () => {
    expect(topicMatches("site.:siteId", "site.abc")).toBe(true);
    expect(topicMatches("site.:siteId", "site.abc.pages")).toBe(false);
    expect(topicMatches("site.:siteId", "page.abc")).toBe(false);
    expect(topicMatches("site.abc", "site.abc")).toBe(true);
    expect(topicMatches("status", "status")).toBe(true);
  });

  test('"user" matches every user.<id>', () => {
    expect(topicMatches("user", "user.42")).toBe(true);
    expect(topicMatches("user", "user.42.x")).toBe(false);
    expect(topicMatches("user", "users.42")).toBe(false);
  });
});

test("userTopic", () => {
  expect(userTopic({ id: 42 })).toBe("user.42");
  expect(userTopic("u_1")).toBe("user.u_1");
  expect(() => userTopic({ id: undefined })).toThrow(InvalidChannelError);
});
