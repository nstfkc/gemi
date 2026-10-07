import { afterEach, describe, expect, test, vi } from "vitest";

import { Storage } from "./Storage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Storage.delete()", () => {
  // It was `static delete() {}` (#608): it type-checked, resolved, and deleted
  // nothing, so the caller believed the object was gone.
  test("forwards to the configured driver", async () => {
    const del = vi.fn(async () => {});
    vi.spyOn(Storage, "getFacadeRoot").mockReturnValue({
      driver: { delete: del },
    } as any);

    await Storage.delete("avatars/a.png");
    await Storage.delete({ name: "b.png", bucket: "other" });

    expect(del).toHaveBeenNthCalledWith(1, "avatars/a.png");
    expect(del).toHaveBeenNthCalledWith(2, { name: "b.png", bucket: "other" });
  });

  test("surfaces the driver's failure instead of swallowing it", async () => {
    vi.spyOn(Storage, "getFacadeRoot").mockReturnValue({
      driver: {
        delete: async () => {
          throw new Error("AccessDenied");
        },
      },
    } as any);

    await expect(Storage.delete("a.png")).rejects.toThrow("AccessDenied");
  });
});

describe("Storage.fetch()", () => {
  function withDriverFetch() {
    const fetch = vi.fn(async () => new Response("x"));
    vi.spyOn(Storage, "getFacadeRoot").mockReturnValue({
      driver: { fetch },
    } as any);
    return fetch;
  }

  test("forwards the signal to the driver, as put() does", async () => {
    const fetch = withDriverFetch();
    const controller = new AbortController();

    await Storage.fetch("a.png", { signal: controller.signal });

    expect(fetch).toHaveBeenCalledWith("a.png", { signal: controller.signal });
  });

  test("still works without options", async () => {
    const fetch = withDriverFetch();

    await Storage.fetch({ name: "a.png", bucket: "other" });

    expect(fetch).toHaveBeenCalledWith({ name: "a.png", bucket: "other" }, {});
  });

  test("rejects an already-aborted signal before reaching the driver", async () => {
    // A custom driver written before the option existed ignores it, so the
    // facade refuses the read itself.
    const fetch = withDriverFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(Storage.fetch("a.png", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Storage.putFromUrl()", () => {
  test("goes through safeFetch, so a private address never reaches the driver", async () => {
    const putStream = vi.fn(async () => "never");
    const put = vi.fn(async () => "never");
    vi.spyOn(Storage, "getFacadeRoot").mockReturnValue({
      driver: { putStream, put },
    } as any);

    await expect(Storage.putFromUrl("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({
      code: "blocked-address",
    });
    expect(putStream).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
