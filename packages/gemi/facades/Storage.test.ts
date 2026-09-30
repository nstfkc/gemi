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
