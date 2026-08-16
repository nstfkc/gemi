import { describe, expect, test } from "vitest";

import {
  joinHandlerMapKey,
  parsePrefixAndKey,
  removeDoubleSlash,
  removeGroupPrefix,
  removeTrailingId,
} from "./routePath";

/**
 * These pin the *transcription*, not the design. Each case is a string the
 * template-literal types in `http/ApiRouter.ts` and `client/types.ts` produce,
 * including the ones they produce by accident — a bare `"health/"` keeps its
 * trailing slash, a second `(group)` in one segment survives. Matching the
 * types matters more than being right, because the strings a user can type into
 * `useQuery` are the ones the types emit.
 *
 * `rpcParity.test.ts` is the other half: it checks the whole walk against
 * `CreateRPC` over the same source, so a divergence these cases miss is caught
 * by construction rather than by having been thought of.
 */
describe("removeDoubleSlash", () => {
  test("collapses every doubled slash", () => {
    expect(removeDoubleSlash("/a//b//c")).toBe("/a/b/c");
    expect(removeDoubleSlash("///a")).toBe("/a");
  });

  test("leaves a single-slash path alone", () => {
    expect(removeDoubleSlash("/a/b")).toBe("/a/b");
  });
});

describe("removeGroupPrefix", () => {
  test("drops a route group and the slash it leaves behind", () => {
    expect(removeGroupPrefix("/(marketing)/pricing")).toBe("/pricing");
    expect(removeGroupPrefix("/(app)")).toBe("/");
  });

  test("drops only the first group, as the type does", () => {
    expect(removeGroupPrefix("/(a)/(b)/x")).toBe("/(b)/x");
  });

  test("leaves an unclosed parenthesis alone", () => {
    expect(removeGroupPrefix("/(oops/x")).toBe("/(oops/x");
  });
});

describe("parsePrefixAndKey", () => {
  test("joins a prefix to a key", () => {
    expect(parsePrefixAndKey("", "/health")).toBe("/health");
    expect(parsePrefixAndKey("/org", "/products")).toBe("/org/products");
  });

  test("collapses the seam a root-mounted router creates", () => {
    expect(parsePrefixAndKey("/org", "/")).toBe("/org");
    expect(parsePrefixAndKey("/", "/")).toBe("/");
    expect(parsePrefixAndKey("/org/", "/products")).toBe("/org/products");
    expect(parsePrefixAndKey("/a", "//b")).toBe("/a/b");
  });

  test("drops a trailing slash once there are two segments", () => {
    expect(parsePrefixAndKey("/org/products", "/")).toBe("/org/products");
    expect(parsePrefixAndKey("", "/health/")).toBe("/health");
  });

  test("keeps a trailing slash the type also keeps", () => {
    // `${T1}/${T2}/` needs two slashes; "health/" has one.
    expect(parsePrefixAndKey("", "health/")).toBe("health/");
  });

  test("strips a route group from a prefix", () => {
    expect(parsePrefixAndKey("/(app)", "/dashboard")).toBe("/dashboard");
    expect(parsePrefixAndKey("/(app)", "/")).toBe("/");
  });

  test("reproduces the slashes a group on both sides of a seam leaves behind", () => {
    // `/(app)/` + `/(admin)/users` hits the `//` branch, whose two halves are
    // degrouped to "/" and "/users" and then rejoined with a third slash. The
    // type really does emit this, so a route declared this way is spelled
    // `"///users"` at every call site and has to be spelled that way here.
    expect(parsePrefixAndKey("/(app)/", "/(admin)/users")).toBe("///users");
  });
});

describe("removeTrailingId", () => {
  test("drops the last param segment so a resource gets its collection path", () => {
    expect(removeTrailingId("/:orgId/products/:productId")).toBe("/:orgId/products");
    expect(removeTrailingId("/products/:id")).toBe("/products");
  });

  test("leaves a path with no param segment alone", () => {
    expect(removeTrailingId("/products")).toBe("/products");
  });

  test("empties a key that is nothing but an id segment", () => {
    // Not a reachable route — and reproducing the empty string is what keeps
    // the plugin from inventing a `/` collection route the types never emitted.
    expect(removeTrailingId("/:id")).toBe("");
  });
});

describe("joinHandlerMapKey", () => {
  test("concatenates raw, groups included, as RouteHandlersParser does", () => {
    expect(joinHandlerMapKey("/org", "/things")).toBe("/org/things");
    expect(joinHandlerMapKey("/(app)", "/things")).toBe("/(app)/things");
  });

  test("treats a bare slash as no segment at all", () => {
    expect(joinHandlerMapKey("/org", "/")).toBe("/org");
  });
});
