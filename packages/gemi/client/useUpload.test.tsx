/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useUpload } from "./useMutation";

/**
 * An `XMLHttpRequest` the test drives by hand. It fires events in the order a
 * browser does, `abort()` included: `readyState` 4 with status 0, the upload's
 * `abort` and `loadend`, then the request's `readystatechange`, `abort` and
 * `loadend`. That is the sequence that used to leave `trigger` pending.
 */
class FakeXHR extends EventTarget {
  static last: FakeXHR | null = null;
  upload = new EventTarget();
  readyState = 0;
  status = 0;
  statusText = "";
  responseText = "";
  responseType = "";
  onreadystatechange: (() => void) | null = null;
  sent = false;

  constructor() {
    super();
    FakeXHR.last = this;
  }

  open() {
    this.readyState = 1;
  }

  send() {
    this.sent = true;
    this.upload.dispatchEvent(new ProgressEvent("loadstart"));
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.dispatchEvent(
      new ProgressEvent("progress", { loaded, total, lengthComputable }),
    );
  }

  respond(status: number, body: string, statusText = "") {
    this.upload.dispatchEvent(new ProgressEvent("load"));
    this.upload.dispatchEvent(new ProgressEvent("loadend"));
    this.readyState = 4;
    this.status = status;
    this.statusText = statusText;
    this.responseText = body;
    this.finish("load");
  }

  fail() {
    this.readyState = 4;
    this.status = 0;
    this.upload.dispatchEvent(new ProgressEvent("error"));
    this.upload.dispatchEvent(new ProgressEvent("loadend"));
    this.finish("error");
  }

  abort() {
    this.readyState = 4;
    this.status = 0;
    this.upload.dispatchEvent(new ProgressEvent("abort"));
    this.upload.dispatchEvent(new ProgressEvent("loadend"));
    this.finish("abort");
  }

  private finish(type: string) {
    this.onreadystatechange?.();
    this.dispatchEvent(new Event("readystatechange"));
    this.dispatchEvent(new ProgressEvent(type));
    this.dispatchEvent(new ProgressEvent("loadend"));
  }
}

const file = () => new File(["hello"], "hello.txt", { type: "text/plain" });

function setup(config: Record<string, unknown> = {}) {
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  const callbacks = {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onCanceled: vi.fn(),
    ...config,
  };
  const hook = renderHook(() =>
    useUpload("/avatar" as never, {} as never, callbacks as never),
  );
  return { ...hook, ...callbacks };
}

// Auto-cleanup needs vitest globals, which this repo doesn't enable.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeXHR.last = null;
});

describe("useUpload", () => {
  test("state goes idle → uploading → done, and trigger resolves the body", async () => {
    const { result, onSuccess, onError } = setup();
    expect(result.current.state).toBe("idle");

    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.trigger(file());
    });
    expect(result.current.state).toBe("uploading");

    await act(async () => {
      FakeXHR.last!.respond(200, JSON.stringify({ id: 1 }));
      await settled;
    });
    await expect(settled).resolves.toEqual({ id: 1 });
    expect(result.current.state).toBe("done");
    expect(result.current.progress).toBe(1);
    expect(onSuccess).toHaveBeenCalledWith({ id: 1 });
    expect(onError).not.toHaveBeenCalled();
  });

  test("a refused upload goes to error with the body's error", async () => {
    const { result, onError } = setup();
    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.trigger(file());
    });
    await act(async () => {
      FakeXHR.last!.respond(
        422,
        JSON.stringify({
          error: { kind: "validation_error", messages: { file: ["Too big"] } },
        }),
      );
      await settled;
    });
    await expect(settled).resolves.toBeUndefined();
    expect(result.current.state).toBe("error");
    expect(onError).toHaveBeenCalledWith({
      kind: "validation_error",
      messages: { file: ["Too big"] },
    });
  });

  test("a refusal that is not JSON is a server_error with the status text", async () => {
    const { result, onError } = setup();
    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.trigger(file());
    });
    await act(async () => {
      FakeXHR.last!.respond(502, "<html>Bad gateway</html>", "Bad Gateway");
      await settled;
    });
    expect(result.current.state).toBe("error");
    expect(onError).toHaveBeenCalledWith({
      kind: "server_error",
      message: "Bad Gateway",
    });
  });

  test("a network error goes to error with a TypeError, and trigger resolves undefined", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { result, onError } = setup();
      let settled!: Promise<unknown>;
      act(() => {
        settled = result.current.trigger(file());
      });
      await act(async () => {
        FakeXHR.last!.fail();
        await settled;
      });
      await expect(settled).resolves.toBeUndefined();
      expect(result.current.state).toBe("error");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(TypeError);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("cancel() mid-upload settles trigger with undefined, without onError", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { result, onError, onCanceled } = setup();
      let settled!: Promise<unknown>;
      act(() => {
        settled = result.current.trigger(file());
      });
      act(() => FakeXHR.last!.progress(50, 100));
      expect(result.current.progress).toBe(0.5);

      await act(async () => {
        result.current.cancel();
        await settled;
      });
      await expect(settled).resolves.toBeUndefined();
      expect(onCanceled).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(result.current.state).toBe("idle");
      expect(result.current.progress).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("cancel() after the upload has finished does nothing", async () => {
    const { result, onCanceled } = setup();
    let settled!: Promise<unknown>;
    act(() => {
      settled = result.current.trigger(file());
    });
    await act(async () => {
      FakeXHR.last!.respond(200, JSON.stringify({ id: 1 }));
      await settled;
    });
    act(() => result.current.cancel());
    expect(onCanceled).not.toHaveBeenCalled();
    expect(result.current.state).toBe("done");
  });

  test("progress ignores events whose length is not computable", async () => {
    const { result } = setup();
    act(() => {
      void result.current.trigger(file());
    });
    act(() => FakeXHR.last!.progress(10, 0, false));
    expect(result.current.progress).toBe(0);
    expect(Number.isNaN(result.current.progress)).toBe(false);
    act(() => FakeXHR.last!.progress(25, 100));
    expect(result.current.progress).toBe(0.25);
  });

  test("no file resolves undefined and sends nothing", async () => {
    const { result } = setup();
    await expect(result.current.trigger(null)).resolves.toBeUndefined();
    expect(FakeXHR.last).toBeNull();
    expect(result.current.state).toBe("idle");
  });
});
