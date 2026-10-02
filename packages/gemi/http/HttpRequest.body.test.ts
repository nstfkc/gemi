import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "./ApiRouter";
import { RequestBreakerError } from "./Error";
import { HttpRequest } from "./HttpRequest";
import { isJsonMediaType, mediaType } from "./mediaType";
import { ViewRouter } from "./ViewRouter";
import { Kernel } from "../kernel";

/**
 * How `HttpRequest` reads a body: which `Content-Type`s are JSON (#699), and
 * what an empty or malformed JSON body answers (#700).
 */

function post(body: BodyInit | null, contentType?: string) {
  return new Request("http://gemi.dev/api/x", {
    method: "POST",
    body,
    headers: contentType ? { "Content-Type": contentType } : {},
  });
}

async function inputOf(req: Request) {
  return (await new HttpRequest<any, any>(req).input()).toJSON();
}

async function refusalOf(req: Request) {
  const err = await new HttpRequest<any, any>(req).input().then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(RequestBreakerError);
  return (err as RequestBreakerError).payload.api;
}

describe("mediaType", () => {
  test("drops parameters and lowercases", () => {
    expect(mediaType("Application/JSON; charset=UTF-8")).toBe("application/json");
    expect(mediaType(" multipart/form-data; boundary=x")).toBe("multipart/form-data");
    expect(mediaType(null)).toBeNull();
    expect(mediaType("; charset=utf-8")).toBeNull();
  });

  test("JSON is application/json or a +json type, not a prefix", () => {
    expect(isJsonMediaType("application/json")).toBe(true);
    expect(isJsonMediaType("application/vnd.api+json")).toBe(true);
    expect(isJsonMediaType("application/merge-patch+json")).toBe(true);
    expect(isJsonMediaType("application/json-seq")).toBe(false);
    expect(isJsonMediaType("text/plain")).toBe(false);
    expect(isJsonMediaType("+json")).toBe(false);
    expect(isJsonMediaType("application/+json")).toBe(false);
    expect(isJsonMediaType(null)).toBe(false);
  });
});

describe("a JSON body is read whatever the Content-Type's spelling (#699)", () => {
  const body = JSON.stringify({ name: "Ada" });

  test.each([
    "application/json",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    "Application/JSON",
    "APPLICATION/JSON; charset=utf-8",
    "application/vnd.api+json",
    "application/merge-patch+json; charset=utf-8",
  ])("%s", async (type) => {
    expect(await inputOf(post(body, type))).toEqual({ name: "Ada" });
  });

  test("a type that only begins like JSON is not JSON", async () => {
    expect(await inputOf(post(body, "application/json-seq"))).toEqual({});
  });

  test("text/plain and no type at all are not read", async () => {
    expect(await inputOf(post(body, "text/plain"))).toEqual({});
    expect(await inputOf(post(body))).toEqual({});
  });
});

describe("forms", () => {
  test("a urlencoded form with a charset is read, into its fields", async () => {
    expect(
      await inputOf(
        post("name=Ada&tag=a&tag=b", "application/x-www-form-urlencoded; charset=UTF-8"),
      ),
    ).toEqual({ name: "Ada", tag: ["a", "b"] });
  });

  test("multipart is read, repeated keys as an array", async () => {
    const form = new FormData();
    form.append("name", "Ada");
    form.append("tag", "a");
    form.append("tag", "b");
    expect(
      await inputOf(new Request("http://gemi.dev/api/x", { method: "POST", body: form })),
    ).toEqual({
      name: "Ada",
      tag: ["a", "b"],
    });
  });

  test("a multipart body that is not one is a 400", async () => {
    expect((await refusalOf(post("garbage", "multipart/form-data; boundary=nope"))).status).toBe(
      400,
    );
  });
});

describe("an empty or malformed JSON body (#700)", () => {
  test("an empty body is no body", async () => {
    expect(await inputOf(post("", "application/json"))).toEqual({});
    expect(await inputOf(post("  \n", "application/json"))).toEqual({});
    expect(await inputOf(post(null, "application/json"))).toEqual({});
  });

  test("a required field on an empty body is a validation error, not a 500", async () => {
    class Req extends HttpRequest<{ name: string }> {
      schema = { name: { required: "Name is required" } };
    }
    const { isValid, errors } = await new Req(post("", "application/json")).safeInput();
    expect(isValid).toBe(false);
    expect(errors).toEqual({ name: ["Name is required"] });
  });

  test("malformed JSON is a 400 refusal", async () => {
    expect(await refusalOf(post("{ name:", "application/json"))).toEqual({
      status: 400,
      data: {
        error: {
          kind: "form_error",
          message: "The request body is not valid JSON.",
          status: 400,
        },
      },
    });
  });

  test("JSON that is not an object is a 400 refusal", async () => {
    for (const text of ["null", "42", '"hi"', "true"]) {
      const api = await refusalOf(post(text, "application/json"));
      expect(api.status).toBe(400);
      expect(api.data.error.message).toBe("The request body must be a JSON object.");
    }
  });

  test("safeInput refuses malformed JSON the same way", async () => {
    await expect(
      new HttpRequest<any, any>(post("{", "application/json")).safeInput(),
    ).rejects.toBeInstanceOf(RequestBreakerError);
  });
});

describe("through the API router", () => {
  class RootApiRouter extends ApiRouter {
    routes = {
      "/echo": this.post(async () => {
        return (await new HttpRequest<any, any>().input()).toJSON();
      }),
    };
  }

  class AppKernel extends Kernel {
    config = {
      route: {
        api: { rootRouter: RootApiRouter },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: class extends ViewRouter {},
        },
      },
    };
  }

  const app = new App({ kernel: AppKernel });
  const echo = (body: BodyInit | null, type: string) =>
    app.fetch(
      new Request("http://gemi.dev/api/echo", {
        method: "POST",
        body,
        headers: { "Content-Type": type },
      }),
    );

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a charset on the type still reaches the handler", async () => {
    const res = await echo(JSON.stringify({ a: 1 }), "application/json; charset=utf-8");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  test("an empty JSON body answers 200 with {}", async () => {
    const res = await echo("", "application/json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("malformed JSON answers 400 with the refusal shape", async () => {
    const res = await echo("{", "application/json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        kind: "form_error",
        message: "The request body is not valid JSON.",
        status: 400,
      },
    });
  });
});
