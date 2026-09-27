import type { ImageProvider } from "./ImageProvider";
import type { ImageResponse } from "./providers/images";
import type { Usage } from "./types";

/**
 * A named image model with its settings, the way `Agent` is a named text model
 * with its settings.
 *
 * `ImageModel`, not `Image`, because `Image` is already gemi's `<img>` srcset
 * component (`client/Image.tsx`). Different entrypoints, so nothing collides
 * technically — and a page builder, which is what this feature is for, imports
 * both in the same file.
 *
 *     export const banner = ImageModel.create({
 *       name: "banner",
 *       provider: AzureOpenAIImageProvider.model("gpt-image-2"),
 *       size: "1536x1024",
 *       quality: "high",
 *     });
 *
 *     const { image, mimeType } = await banner.generate({ prompt });
 *     await Storage.put({ name: `pages/${id}/hero.png`, body: image, contentType: mimeType });
 *
 * Inside an agent tool, call `ctx.generateImage(banner, …)` instead: it memoizes
 * the render against the tool call so a replay does not pay for it twice, and it
 * parks the bytes as an attachment. See `ToolContext.generateImage`.
 */

/**
 * `WIDTHxHEIGHT`, or `auto`.
 *
 * NOT A CLOSED UNION OF THREE LITERALS, which is what the older image models
 * allowed and what a first draft of this type was. `gpt-image-2` takes arbitrary
 * dimensions, and a page builder deriving a size from a layout slot's aspect
 * ratio is precisely the caller that needs them.
 */
export type ImageSize = `${number}x${number}` | "auto";
export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageBackground = "transparent" | "opaque" | "auto";

/**
 * `png` or `jpeg`. Not `webp`, although every source lists it — measured against
 * `gpt-image-2`:
 *
 *     400 Invalid value: 'webp'. Supported values are: 'png' and 'jpeg'.
 *         param: output_format
 */
export type ImageFormat = "png" | "jpeg";

type Settings = {
  size?: ImageSize;
  quality?: ImageQuality;
  background?: ImageBackground;
  format?: ImageFormat;
  /** JPEG quality, 0–100. Ignored by the vendor for PNG. */
  compression?: number;
};

export type CreateImageModelParams = Settings & {
  /** For logs and, later, telemetry — the same role `Agent.name` plays. */
  name: string;
  provider: ImageProvider;
};

export type GenerateImageParams = Settings & {
  prompt: string;
  /** Aborts the render. Inside a tool, `ctx.generateImage` passes the run's. */
  signal?: AbortSignal;
};

export type ImageInput = Blob | File;

export type EditImageParams = GenerateImageParams & {
  /**
   * The images to edit, at least one. Typed as a non-empty tuple so an empty
   * array is a compile error rather than a paid call that quietly generates from
   * scratch.
   */
  images: [ImageInput, ...ImageInput[]];
  /**
   * A PNG with an alpha channel, the same dimensions as the input. The
   * **transparent** region is the part to replace.
   *
   * MEASURED, and honoured rather than merely accepted: with a transparent
   * centre square and the prompt "put a yellow star in the masked area", the
   * centre came back yellow and the surrounding ring kept the original colour,
   * while the same edit without a mask recoloured the whole image.
   */
  mask?: ImageInput;
};

/**
 * One generated image.
 *
 * NO `revisedPrompt`. It was in the original design, the requesting app asked
 * for it, and `gpt-image-2` does not return one — five successful responses,
 * generations and edits, none carrying `revised_prompt`. A field that is always
 * `undefined` teaches callers to write dead branches; adding it back if a model
 * ever populates it is not a breaking change.
 */
export type GeneratedImage = {
  /** The bytes, with `type` set — ready for `Storage.put` or
   *  `ctx.attachments.put`, neither of which accepts a `Uint8Array`. */
  image: Blob;
  mimeType: string;
  /**
   * What was actually produced, read off the response and never assumed.
   *
   * MEASURED: an edit sent with no `size` answered `1254x1254` — neither a size
   * anyone asked for nor a multiple of 16. So the divisible-by-16 rule below
   * constrains the *request* and says nothing about the answer.
   */
  size: string;
  usage: Usage;
};

/** The measured request rules. Each one is a real 400, quoted. */
function assertSize(size: string): void {
  if (size === "auto") return;

  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    throw new Error(`An image size is "WIDTHxHEIGHT" or "auto"; got ${JSON.stringify(size)}.`);
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  // 400 Invalid size '1000x1000'. Width and height must both be divisible by 16.
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error(
      `Image size ${size} is not supported: width and height must both be divisible by 16.`,
    );
  }

  // 400 Invalid size '1024x256'. The maximum supported aspect ratio is 3:1.
  if (Math.max(width / height, height / width) > 3) {
    throw new Error(
      `Image size ${size} is not supported: the maximum aspect ratio is 3:1, either way up.`,
    );
  }
}

function assertSettings(settings: Settings, where: string): void {
  if (settings.size !== undefined) {
    try {
      assertSize(settings.size);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
  }

  // 400 Transparent background is not supported for JPEG output format
  if (settings.background === "transparent" && settings.format === "jpeg") {
    throw new Error(`${where}: a transparent background needs "png"; JPEG has no alpha channel.`);
  }

  if (settings.compression !== undefined) {
    const value = settings.compression;
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`${where}: compression is an integer from 0 to 100; got ${value}.`);
    }
  }
}

function toBlob(input: ImageInput, fallbackName: string): File {
  if (input instanceof File) return input;
  // A Blob built from raw bytes has no name, and the vendor reads the part's
  // filename: an extensionless part is answered with a type error rather than a
  // useful one.
  const type = input.type || "image/png";
  const extension = type === "image/jpeg" ? "jpg" : (type.split("/")[1] ?? "png");
  return new File([input], `${fallbackName}.${extension}`, { type });
}

export class ImageModel {
  readonly name: string;
  readonly provider: ImageProvider;
  private readonly settings: Settings;

  private constructor(params: CreateImageModelParams) {
    const { name, provider, ...settings } = params;
    // Checked here as well as per call, so a bad default fails when the module
    // loads rather than on whichever request first happens to hit it.
    assertSettings(settings, `ImageModel "${name}"`);
    this.name = name;
    this.provider = provider;
    this.settings = settings;
  }

  static create(params: CreateImageModelParams): ImageModel {
    return new ImageModel(params);
  }

  async generate(params: GenerateImageParams): Promise<GeneratedImage> {
    const merged = this.merge(params);
    return present(
      await this.provider.generate({ prompt: params.prompt, ...merged, signal: params.signal }),
    );
  }

  /**
   * Edits one or more images.
   *
   * A SEPARATE METHOD, not an `images?` on `generate`. One method would mean an
   * `images` that arrives `undefined` — a mistyped field, a destructure of the
   * wrong object — silently generates a fresh image instead of editing: the
   * wrong picture, no error, on a call that is billed either way. Requiring a
   * non-empty `images` here makes "edit with nothing to edit" unspellable.
   */
  async edit(params: EditImageParams): Promise<GeneratedImage> {
    const merged = this.merge(params);
    return present(
      await this.provider.edit({
        prompt: params.prompt,
        ...merged,
        images: params.images.map((image, index) => toBlob(image, `image-${index}`)),
        ...(params.mask ? { mask: toBlob(params.mask, "mask") } : {}),
        signal: params.signal,
      }),
    );
  }

  /** Per-call params over the model's defaults, validated as one. */
  private merge(params: Settings): Settings {
    const merged: Settings = {
      ...this.settings,
      ...(params.size !== undefined ? { size: params.size } : {}),
      ...(params.quality !== undefined ? { quality: params.quality } : {}),
      ...(params.background !== undefined ? { background: params.background } : {}),
      ...(params.format !== undefined ? { format: params.format } : {}),
      ...(params.compression !== undefined ? { compression: params.compression } : {}),
    };
    // The merged pair is what matters: a model with `background: "transparent"`
    // and a call passing `format: "jpeg"` is the combination the vendor rejects,
    // and neither half is wrong on its own.
    assertSettings(merged, `ImageModel "${this.name}"`);
    return merged;
  }
}

function present(response: ImageResponse): GeneratedImage {
  return {
    image: new Blob([response.bytes as BlobPart], { type: response.mimeType }),
    mimeType: response.mimeType,
    size: response.size,
    usage: response.usage,
  };
}
