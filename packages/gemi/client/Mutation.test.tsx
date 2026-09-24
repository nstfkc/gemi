/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Form } from "./Mutation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function submit(form: HTMLFormElement) {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

describe("Form", () => {
  /**
   * `handleSubmit` returns early while a submit is in flight, so the same
   * submit is not sent twice. Returning before `preventDefault` left the
   * event to the browser, which submits the form itself — a second click on
   * a slow submit navigated the page and abandoned the request.
   */
  test("a second submit while one is in flight is swallowed, not handed to the browser", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);

    const { container } = render(
      <Form method={"POST" as never} action={"/agents" as never}>
        <button type="submit">Save</button>
      </Form>,
    );
    const form = container.querySelector("form")!;

    expect(submit(form).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(form.dataset.loading).toBe("true");

    expect(submit(form).defaultPrevented).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
