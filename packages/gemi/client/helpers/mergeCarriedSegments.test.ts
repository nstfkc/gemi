import { describe, test, expect } from "vitest";

import { mergeCarriedSegments } from "./mergeCarriedSegments";

const previous = {
  pathname: "/app/A/chat",
  routePath: "/app/:orgId/chat",
  data: {
    "/app/A/chat": {
      AppLayout: { user: { id: 1 } },
      Chat: { messages: [] },
    },
  },
  breadcrumbs: {
    "AppLayout:/app/:orgId/chat": { label: "App", href: "/app/:orgId" },
    "Chat:/app/:orgId/chat": { label: "Chat", href: "/chat" },
  },
};

const next = {
  pathname: "/app/A/lists",
  routePath: "/app/:orgId/lists",
  data: { "/app/A/lists": { Lists: { lists: [] } } },
  breadcrumbs: { "Lists:/app/:orgId/lists": { label: "Lists", href: "/lists" } },
};

describe("mergeCarriedSegments()", () => {
  test("moves carried view data under the new pathname", () => {
    const { data } = mergeCarriedSegments(previous, next, ["AppLayout"]);

    expect(data).toEqual({
      "/app/A/lists": {
        AppLayout: { user: { id: 1 } },
        Lists: { lists: [] },
      },
    });
  });

  test("carries nothing when the server rendered everything", () => {
    const result = mergeCarriedSegments(previous, next, []);

    expect(result.data).toBe(next.data);
    expect(result.breadcrumbs).toBe(next.breadcrumbs);
  });

  test("leaves views the server did render alone", () => {
    const { data } = mergeCarriedSegments(previous, next, ["Chat"]);

    expect(data["/app/A/lists"].Chat).toEqual({ messages: [] });
    expect(data["/app/A/lists"].Lists).toEqual({ lists: [] });
  });

  test("a re-rendered view wins over the carried copy", () => {
    const rerendered = {
      ...next,
      data: { "/app/A/lists": { AppLayout: { user: { id: 2 } }, Lists: {} } },
    };

    const { data } = mergeCarriedSegments(rerendered, rerendered, ["AppLayout"]);

    expect(data["/app/A/lists"].AppLayout).toEqual({ user: { id: 2 } });
  });

  test("re-keys carried breadcrumbs onto the new route pattern", () => {
    const { breadcrumbs } = mergeCarriedSegments(previous, next, ["AppLayout"]);

    expect(breadcrumbs).toEqual({
      "AppLayout:/app/:orgId/lists": { label: "App", href: "/app/:orgId" },
      "Lists:/app/:orgId/lists": { label: "Lists", href: "/lists" },
    });
  });

  test("reads the key the data is under when a shallow navigation moved the pathname", () => {
    const shallow = { ...previous, pathname: "/app/A/chat?thread=2" };

    const { data } = mergeCarriedSegments(shallow, next, ["AppLayout"]);

    expect(data["/app/A/lists"].AppLayout).toEqual({ user: { id: 1 } });
  });

  test("does not invent an entry for a view it has no data for", () => {
    const { data } = mergeCarriedSegments(previous, next, ["Unknown"]);

    expect(data["/app/A/lists"]).toEqual({ Lists: { lists: [] } });
    expect("Unknown" in data["/app/A/lists"]).toBe(false);
  });

  test("survives an empty previous state", () => {
    const empty = { pathname: "/", routePath: "/", data: {}, breadcrumbs: {} };

    const { data, breadcrumbs } = mergeCarriedSegments(empty, next, ["AppLayout"]);

    expect(data).toEqual(next.data);
    expect(breadcrumbs).toEqual(next.breadcrumbs);
  });
});
