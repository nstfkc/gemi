import { describe, expect, test, vi } from "vitest";

import { ImageModel } from "./ImageModel";
import { AzureOpenAIImageProvider, OpenAIImageProvider } from "./ImageProvider";
import GENERATION from "./providers/__fixtures__/openai-image-generation.json";
import EDIT from "./providers/__fixtures__/openai-image-edit.json";
import WEBP_ERROR from "./providers/__fixtures__/openai-image-error-webp.json";
import { ImageRequestError } from "./providers/images";

/**
 * The fixtures are real responses from a `gpt-image-2` deployment with the
 * base64 swapped for a 2x2 PNG — the field names, the `usage` details and the
 * edit's surprising `size` are all as measured. See `providers/images.ts`.
 */
function stubFetch(body: unknown = GENERATION, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return calls;
}

const png = () => new File([new Uint8Array([1, 2, 3])], "base.png", { type: "image/png" });

describe("ImageModel.generate", () => {
  test("posts the vendor's field names and hands back a typed Blob", async () => {
    const calls = stubFetch();
    const banner = ImageModel.create({
      name: "banner",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "sk-test" }),
      size: "1536x1024",
      quality: "high",
    });

    const result = await banner.generate({ prompt: "a market street" });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "gpt-image-2",
      prompt: "a market street",
      size: "1536x1024",
      quality: "high",
    });

    expect(result.image).toBeInstanceOf(Blob);
    expect(result.image.type).toBe("image/png");
    expect(result.mimeType).toBe("image/png");
    // Real bytes, not an empty Blob: a PNG signature survived the base64.
    const head = new Uint8Array(await result.image.slice(0, 4).arrayBuffer());
    expect(Array.from(head)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("per-call params override the model's defaults", async () => {
    const calls = stubFetch();
    const banner = ImageModel.create({
      name: "banner",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
      size: "1536x1024",
      quality: "high",
    });

    await banner.generate({ prompt: "x", quality: "low" });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.quality).toBe("low");
    // ...and the ones it did not override survive.
    expect(body.size).toBe("1536x1024");
  });

  test("the size comes off the response, because the model does not always give what was asked", async () => {
    // Measured: an edit sent with no `size` answered 1254x1254 — not requested,
    // and not a multiple of 16. Anything that echoed the request here would be
    // reporting a size the bytes do not have.
    stubFetch(EDIT);
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    const result = await model.generate({ prompt: "x" });

    expect(result.size).toBe("1254x1254");
  });
});

describe("usage", () => {
  test("image tokens are reported as a breakdown of the provider's own totals", async () => {
    stubFetch(EDIT);
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    const { usage } = await model.generate({ prompt: "x" });

    expect(usage).toEqual({
      inputTokens: 1038,
      outputTokens: 229,
      totalTokens: 1267,
      imageInputTokens: 1024,
      imageOutputTokens: 229,
    });
    // The relationship that makes them a breakdown rather than a second bucket:
    // the provider's own total already contains them.
    expect(usage.imageInputTokens! + 14).toBe(usage.inputTokens);
  });

  test("a generation with no input image says so, rather than omitting the field", async () => {
    stubFetch(GENERATION);
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    const { usage } = await model.generate({ prompt: "x" });

    expect(usage.imageInputTokens).toBe(0);
    expect(usage.imageOutputTokens).toBe(196);
  });
});

describe("Azure", () => {
  test("posts to the v1 images path with the deployment in the body", async () => {
    const calls = stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: AzureOpenAIImageProvider.model("gpt-image-2", {
        endpoint: "https://res.cognitiveservices.azure.com",
        apiKey: "azure-key",
      }),
    });

    await model.generate({ prompt: "x" });

    expect(calls[0]!.url).toBe(
      "https://res.cognitiveservices.azure.com/openai/v1/images/generations?api-version=preview",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("azure-key");
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("gpt-image-2");
  });

  test("an endpoint that already ends in /openai does not get a second one", async () => {
    // The images path inherits this from the shared resolver rather than
    // reimplementing it — which is the entire reason the resolver is shared.
    const calls = stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: AzureOpenAIImageProvider.model("gpt-image-2", {
        endpoint: "https://res.openai.azure.com/openai",
        apiKey: "k",
      }),
    });

    await model.generate({ prompt: "x" });

    expect(calls[0]!.url).toBe(
      "https://res.openai.azure.com/openai/v1/images/generations?api-version=preview",
    );
  });

  test("a deployment named something else is an override, not a different method", async () => {
    const calls = stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: AzureOpenAIImageProvider.model("gpt-image-2", {
        endpoint: "https://res.openai.azure.com",
        apiKey: "k",
        deployment: "images-prod",
      }),
    });

    await model.generate({ prompt: "x" });

    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("images-prod");
  });
});

describe("ImageModel.edit", () => {
  test("sends multipart with one image[] part per input, plus the mask", async () => {
    const calls = stubFetch(EDIT);
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
      size: "1024x1024",
    });

    await model.edit({
      prompt: "make it warmer",
      images: [png(), png()],
      mask: new File([new Uint8Array([9])], "mask.png", { type: "image/png" }),
    });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/edits");
    const form = calls[0]!.init.body as FormData;
    // Repeated, not overwritten: measured, two parts cost 2048 input image
    // tokens against 1024 for one, so the vendor reads each part.
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.get("mask")).toBeInstanceOf(File);
    expect(form.get("prompt")).toBe("make it warmer");
    expect(form.get("size")).toBe("1024x1024");
    // The boundary is the body's to write.
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  test("a Blob with no name still reaches the vendor under one, with an extension", async () => {
    // The vendor reads the part's filename; an extensionless part is answered
    // with a type error rather than a useful one.
    const calls = stubFetch(EDIT);
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    await model.edit({
      prompt: "x",
      images: [new Blob([new Uint8Array([1])], { type: "image/jpeg" })],
    });

    const file = (calls[0]!.init.body as FormData).get("image[]") as File;
    expect(file.name).toBe("image-0.jpg");
    expect(file.type).toBe("image/jpeg");
  });
});

describe("what is refused before a request is paid for", () => {
  // Every message below is a measured 400, refused locally instead.
  test("a size whose edges are not divisible by 16", async () => {
    stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    await expect(model.generate({ prompt: "x", size: "1000x1000" })).rejects.toThrow(
      /divisible by 16/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("an aspect ratio past 3:1, either way up", async () => {
    stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    await expect(model.generate({ prompt: "x", size: "1024x256" })).rejects.toThrow(/3:1/);
    await expect(model.generate({ prompt: "x", size: "256x1024" })).rejects.toThrow(/3:1/);
  });

  test("a transparent background on a format with no alpha channel", async () => {
    stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    await expect(
      model.generate({ prompt: "x", background: "transparent", format: "jpeg" }),
    ).rejects.toThrow(/transparent background needs "png"/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("and that pair is caught across the default/override seam, where neither half is wrong alone", async () => {
    stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
      background: "transparent",
    });

    // The model is fine. The call is fine. Together they are the measured 400.
    await expect(model.generate({ prompt: "x", format: "jpeg" })).rejects.toThrow(
      /transparent background needs "png"/,
    );
  });

  test("a bad default fails when the model is created, not on the first request", () => {
    expect(() =>
      ImageModel.create({
        name: "banner",
        provider: OpenAIImageProvider.model("gpt-image-2"),
        size: "1000x1000",
      }),
    ).toThrow(/banner.*divisible by 16/s);
  });

  test('"auto" is a size, and is not measured against the pixel rules', async () => {
    const calls = stubFetch();
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    await model.generate({ prompt: "x", size: "auto" });

    expect(JSON.parse(String(calls[0]!.init.body)).size).toBe("auto");
  });
});

describe("failure", () => {
  test("a provider error arrives normalized, without the vendor's body in the message", async () => {
    // A throw inside a tool becomes a tool result the model reads (#446), so the
    // body belongs on `cause` and not in `message`.
    stubFetch(WEBP_ERROR, 400);
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    const error = await model.generate({ prompt: "x" }).catch((e) => e);

    expect(error).toBeInstanceOf(ImageRequestError);
    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(false);
  });

  test("an answer carrying no image data is an error, not an empty Blob", async () => {
    // The endpoint has a `url` response mode for other models; a deployment
    // answering with one would otherwise reach the caller as zero bytes.
    stubFetch({ data: [{ url: "https://example/img.png" }], usage: {} });
    const model = ImageModel.create({
      name: "m",
      provider: OpenAIImageProvider.model("gpt-image-2", { apiKey: "k" }),
    });

    await expect(model.generate({ prompt: "x" })).rejects.toThrow(/no base64 image data/);
  });
});
