/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
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

  /**
   * The caller's `onSubmit` used to be spread over the `<form>` after gemi's
   * own and replace it: no `preventDefault`, so the browser submitted the
   * form itself, and no request. TypeScript accepted the prop without a word.
   */
  test("a caller's onSubmit runs, and the submit still sends its request", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const onSubmit = vi.fn();

    const { container } = render(
      <Form
        method={"POST" as never}
        action={"/agents" as never}
        onSubmit={onSubmit}
      >
        <button type="submit">Save</button>
      </Form>,
    );
    const form = container.querySelector("form")!;

    expect(submit(form).defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });

  /**
   * The default is prevented before the caller's `onSubmit` runs, so a
   * reflexive `event.preventDefault()` in it — the habit from plain forms —
   * must not read as "cancel". Skipping a request is `onSubmitStart`'s job.
   */
  test("a caller's preventDefault does not cancel the request", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);

    const { container } = render(
      <Form
        method={"POST" as never}
        action={"/agents" as never}
        onSubmit={(event) => event.preventDefault()}
      />,
    );

    submit(container.querySelector("form")!);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });

  test("onSubmitStart fires before the request, with the FormData that is sent", async () => {
    const order: string[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      order.push("fetch");
      expect(init.body).toBe(seen);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetch);
    let seen: FormData | undefined;
    let seenForm: HTMLFormElement | undefined;

    const { container } = render(
      <Form
        method={"POST" as never}
        action={"/agents" as never}
        dynamicInputs={() => ({ extra: "1" })}
        onSubmitStart={(formData, form) => {
          order.push("start");
          seen = formData;
          seenForm = form;
        }}
      >
        <input name="name" defaultValue="Ada" />
      </Form>,
    );
    const form = container.querySelector("form")!;

    submit(form);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(order).toEqual(["start", "fetch"]);
    expect(seenForm).toBe(form);
    expect(seen?.get("name")).toBe("Ada");
    expect(seen?.get("extra")).toBe("1");
  });

  test("onSubmitStart returning false skips the request", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const onSubmitStart = vi.fn(() => false);

    const { container } = render(
      <Form
        method={"POST" as never}
        action={"/agents" as never}
        onSubmitStart={onSubmitStart}
      />,
    );
    const form = container.querySelector("form")!;

    expect(submit(form).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSubmitStart).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(form.dataset.loading).toBe("false");
  });

  test("onSettled runs after onSuccess and after onError", async () => {
    const calls: string[] = [];
    const respond = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }));

    vi.stubGlobal("fetch", respond(200, { ok: true }));
    const { container } = render(
      <Form
        method={"POST" as never}
        action={"/agents" as never}
        onSuccess={() => calls.push("success")}
        onError={() => calls.push("error")}
        onSettled={(form) => calls.push(`settled:${form.tagName}`)}
      />,
    );
    const form = container.querySelector("form")!;

    submit(form);
    await waitFor(() => expect(calls).toEqual(["success", "settled:FORM"]));
    await waitFor(() => expect(form.dataset.loading).toBe("false"));

    vi.stubGlobal(
      "fetch",
      respond(422, { error: { kind: "form_error", message: "No" } }),
    );
    submit(form);
    await waitFor(() =>
      expect(calls).toEqual([
        "success",
        "settled:FORM",
        "error",
        "settled:FORM",
      ]),
    );
  });

  /**
   * A caller's `ref` sat in the same spread and replaced the one `<Form>`
   * reads its fields through, so every submit returned early.
   */
  test("a caller's ref gets the form, and the submit still sends", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const ref = createRef<HTMLFormElement>();

    const { container, unmount } = render(
      <Form method={"POST" as never} action={"/agents" as never} ref={ref} />,
    );
    const form = container.querySelector("form")!;

    expect(ref.current).toBe(form);
    submit(form);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    unmount();
    expect(ref.current).toBeNull();
  });
});
