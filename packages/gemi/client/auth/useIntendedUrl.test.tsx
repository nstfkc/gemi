/** @vitest-environment node */
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";

import { useIntendedUrl } from "./useIntendedUrl";
import { RouteStateProvider, type PageData, type RouteState } from "../RouteStateContext";

/**
 * The hook a sign-in page calls to find where to send the user next. Both
 * templates render it, and the value it returns comes straight off the query
 * string, so what it refuses matters as much as what it returns.
 */
function renderIntended(search: string, fallback?: string) {
  function View() {
    return <span>{useIntendedUrl(fallback)}</span>;
  }
  return renderToString(
    <RouteStateProvider
      state={
        {
          pathname: "/auth/sign-in",
          search,
          hash: "",
          params: {},
          locale: null,
        } as RouteState & PageData
      }
    >
      <View />
    </RouteStateProvider>,
  );
}

const intended = (search: string, fallback?: string) =>
  renderIntended(search, fallback).replace(/<\/?span[^>]*>/g, "");

describe("useIntendedUrl", () => {
  test("returns the page the sign-in redirect carried", () => {
    expect(intended("?redirect=%2Finvoices%3Fpage%3D2")).toBe("/invoices?page=2");
  });

  test("falls back when there is no parameter", () => {
    expect(intended("")).toBe("/");
    expect(intended("", "/dashboard")).toBe("/dashboard");
    expect(intended("?other=1", "/dashboard")).toBe("/dashboard");
  });

  /**
   * The parameter is attacker-writable: a link to the app's own sign-in page
   * carrying one of these would sign the victim in and hand them elsewhere.
   */
  test.each([
    ["an absolute URL", "https%3A%2F%2Fevil.example"],
    ["a protocol-relative URL", "%2F%2Fevil.example"],
    ["a javascript: URL", "javascript%3Aalert(1)"],
    ["a path that composes into a protocol-relative URL", "%2F..%2F%2Fevil.example"],
    ["a backslash", "%2F%5Cevil.example"],
  ])("refuses %s", (_, value) => {
    expect(intended(`?redirect=${value}`, "/dashboard")).toBe("/dashboard");
  });
});
