import { describe, expect, test } from "vitest";
import { Redirect } from "./Redirect";

/** The `Location` a `Redirect` throw carries, and the directive beside it. */
function locationOf(fn: () => void) {
  try {
    fn();
  } catch (error) {
    const payload = (error as { payload?: any }).payload;
    if (!payload) throw error;
    return {
      location: payload.view.headers.Location,
      directive: payload.api.directive.path,
      status: payload.view.status,
    };
  }
  throw new Error("Redirect did not throw");
}

describe("Redirect.to", () => {
  /**
   * `applyParams` strips a trailing slash, so the root collapsed to `""` and
   * the `filter(Boolean)` after it dropped the path altogether — an empty
   * `Location`. `Auth.intendedUrl()` returns `/` whenever there is no page to
   * go back to, which is the documented way to call this.
   */
  test("the root is a location, not an empty string", () => {
    const { location, directive } = locationOf(() => Redirect.to("/" as never));
    expect(location).toBe("/");
    expect(directive).toBe("/");
  });

  test("keeps an ordinary path and its query", () => {
    expect(locationOf(() => Redirect.to("/invoices" as never)).location).toBe("/invoices");
    expect(
      locationOf(() => Redirect.to("/invoices" as never, { search: { page: "2" } } as never))
        .location,
    ).toBe("/invoices?page=2");
  });
});
