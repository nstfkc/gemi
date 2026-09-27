import {
  azureTarget,
  openAITarget,
  type AzureConfig,
  type ProviderConfig,
} from "./providers/endpoints";
import { normalizeProviderError } from "./providers/errors";
import {
  DEFAULT_IMAGE_TIMEOUT_MS,
  editImage,
  generateImage,
  imagesEndpoint,
  type ImageGenerationRequest,
  type ImageResponse,
  type ImagesEndpoint,
} from "./providers/images";
import type { AgentError } from "./types";

/**
 * A provider that makes images, separate from the one that makes text.
 *
 * WHY NOT A METHOD ON `AgentProvider`. `provider.generateImage(...)` was the
 * requested shape and it does not survive two facts about this codebase.
 *
 * First, `AgentProvider` is abstract with `stream` and `upload`, and a third
 * abstract member breaks every implementor — including gemi's own `FakeProvider`
 * (duck-typed) and `RecordingProvider` (hand-implements all five members). A
 * capability that only one vendor surface has should not be a hole punched in the
 * interface every other surface has to fill.
 *
 * Second, and this is the real one: an image deployment would have to lie about
 * itself. `capabilities` is computed in the constructor from the model id, and
 * `capabilitiesForModel` deliberately grants an unrecognised id *every*
 * capability — so `AzureOpenAIProvider.model("gpt-image-2")` claims structured
 * output, reasoning and tool search, and exposes a `stream()` that is callable
 * and broken. Splitting the hierarchy makes the wrong call unspellable instead
 * of merely wrong, which is the same reasoning `ScopedAttachments` is built on.
 *
 * What the two hierarchies *do* share is the part worth sharing: which host,
 * which credential, and Azure's api-version fork. That is `providers/endpoints.ts`
 * and neither class reimplements it.
 */
export abstract class ImageProvider {
  /** The model, or on Azure the model the deployment serves. */
  abstract readonly model: string;

  /** For autocomplete only; any string is accepted, because a model released
   *  next Tuesday must not need a gemi release to use. */
  static models(): readonly string[] {
    return [];
  }

  protected abstract endpoint(): ImagesEndpoint;

  /** What goes in the body's `model`. The deployment, on Azure. */
  protected modelName(): string {
    return this.model;
  }

  async generate(params: ImageProviderParams): Promise<ImageResponse> {
    return await generateImage(this.endpoint(), this.body(params), { signal: params.signal });
  }

  /**
   * An edit. `images` is required and non-empty — see `ImageModel.edit` for why
   * that is a separate method rather than an optional field on `generate`.
   */
  async edit(params: ImageProviderEditParams): Promise<ImageResponse> {
    const form = new FormData();
    for (const [key, value] of Object.entries(this.body(params))) {
      if (value !== undefined) form.set(key, String(value));
    }
    // Repeated `image[]`, measured: two parts reported 2048 input image tokens
    // against 1024 for one, so each part is read as its own image rather than
    // the last one winning.
    for (const image of params.images) form.append("image[]", image, image.name);
    if (params.mask) form.set("mask", params.mask, params.mask.name);
    return await editImage(this.endpoint(), form, { signal: params.signal });
  }

  /**
   * Maps gemi's params onto the vendor's field names.
   *
   * On the base class rather than in each subclass: OpenAI and Azure take the
   * same body, and the only difference is that Azure's `model` names a
   * deployment — which `modelName()` answers.
   */
  protected body(params: ImageProviderParams): ImageGenerationRequest {
    return {
      model: this.modelName(),
      prompt: params.prompt,
      ...(params.size ? { size: params.size } : {}),
      ...(params.quality ? { quality: params.quality } : {}),
      ...(params.background ? { background: params.background } : {}),
      ...(params.format ? { output_format: params.format } : {}),
      ...(params.compression !== undefined ? { output_compression: params.compression } : {}),
    };
  }

  /** As `AgentProvider.normalizeError`, so an app branches on `rate_limited`
   *  without caring which surface produced it. */
  normalizeError(error: unknown): AgentError {
    return normalizeProviderError(error);
  }
}

export type ImageProviderParams = {
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  format?: string;
  compression?: number;
  signal?: AbortSignal;
};

export type ImageProviderEditParams = ImageProviderParams & {
  images: File[];
  mask?: File;
};

/**
 * Autocomplete, not a gate — and short on purpose. These are the image models
 * with a Responses-era `/images` surface; `gpt-image-2` is the one measured.
 */
const OPENAI_IMAGE_MODELS = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"] as const;

export class OpenAIImageProvider extends ImageProvider {
  readonly model: string;
  protected readonly config: ProviderConfig;

  constructor(model: string, config: ProviderConfig = {}) {
    super();
    this.model = model;
    this.config = config;
  }

  static model(model: string, config?: ProviderConfig): OpenAIImageProvider {
    return new OpenAIImageProvider(model, config);
  }

  static models(): readonly string[] {
    return OPENAI_IMAGE_MODELS;
  }

  protected endpoint(): ImagesEndpoint {
    return imagesEndpoint(openAITarget(this.config, { timeoutMs: DEFAULT_IMAGE_TIMEOUT_MS }));
  }
}

/**
 * Azure's image surface, which is the same resource and credential as its chat
 * surface — an app that already configured `AZURE_OPENAI_*` for an agent writes
 * only the deployment name here.
 *
 * `.model()`, not `.deployment()`, for the symmetry `AzureOpenAIProvider` keeps:
 * apps name a model and `AzureConfig.deployment` is the override for a resource
 * whose deployment is called something else.
 */
export class AzureOpenAIImageProvider extends ImageProvider {
  readonly model: string;
  protected readonly config: AzureConfig;

  constructor(model: string, config: AzureConfig = {}) {
    super();
    this.model = model;
    this.config = config;
  }

  static model(model: string, config?: AzureConfig): AzureOpenAIImageProvider {
    return new AzureOpenAIImageProvider(model, config);
  }

  static models(): readonly string[] {
    return OPENAI_IMAGE_MODELS;
  }

  protected modelName(): string {
    return this.config.deployment ?? this.model;
  }

  protected endpoint(): ImagesEndpoint {
    return imagesEndpoint(azureTarget(this.config, { timeoutMs: DEFAULT_IMAGE_TIMEOUT_MS }));
  }
}
