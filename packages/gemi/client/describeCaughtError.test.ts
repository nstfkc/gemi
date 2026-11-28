import { describe, expect, test } from "vitest";

import { describeCaughtError } from "./describeCaughtError";

describe("describeCaughtError", () => {
  test("an Error: name, message, stack and the component stack", () => {
    const error = new TypeError("Invalid state: Reader released");
    const text = describeCaughtError(error, "\n    at Builder\n    at Route");

    expect(text).toContain("TypeError: Invalid state: Reader released");
    expect(text).toContain(error.stack!);
    expect(text).toContain("Component stack:\n    at Builder\n    at Route");
  });

  test("an Error's cause is named", () => {
    const text = describeCaughtError(new Error("stream failed", { cause: new Error("socket closed") }));
    expect(text).toContain("Caused by: Error: socket closed");
  });

  test("a plain object is spelled out rather than printed as `{}`", () => {
    const text = describeCaughtError({ code: "provider_error", message: "The provider stream failed." });
    expect(text).toContain('Object { code: "provider_error", message: "The provider stream failed." }');
  });

  test("an empty object says so", () => {
    expect(describeCaughtError({})).toContain("Object {} (no own fields)");
  });

  test("an Event shows its type even though its fields are not its own", () => {
    const text = describeCaughtError(new Event("error"));
    expect(text).toContain("Event {");
    expect(text).toContain('type: "error"');
  });

  test("a thrown primitive, null and undefined", () => {
    expect(describeCaughtError("boom")).toContain("string boom");
    expect(describeCaughtError(null)).toContain("null (nothing was thrown with it)");
    expect(describeCaughtError(undefined)).toContain("undefined (nothing was thrown with it)");
  });
});
