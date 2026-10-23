import { app } from "../../foundation/app";
import { ApiRouter, HttpRequest } from "../../http";
import { configuredAppOrigin } from "../../utils/appOrigin";
import { imageConfigDefaults, type ImageConfig } from "./config";
import { fetchSourceImage, ImageSourceError } from "./fetchSourceImage";
import type { ImageOptimizationDriver } from "./drivers/ImageOptimizationDriver";
import type { ResizeParameters } from "./drivers/types";

export class ImageOptimizationRouter extends ApiRouter {
  routes = {
    "/resize": this.file(async () => {
      const req = new HttpRequest();
      const url = new URL(req.rawRequest.url);
      const rawImageUrl = url.searchParams.get("url");
      const width = Number(url.searchParams.get("w"));
      const height = Number(url.searchParams.get("h"));
      const fit = url.searchParams.get("fit") ?? "cover";
      const quality = Number(url.searchParams.get("q"));

      if (!rawImageUrl) {
        return errorResponse(400, "url query parameter is required");
      }

      const manager = app(ImageManager);
      // Both schemes: behind a TLS proxy the request may arrive as http.
      const ownOrigins = [url.origin, `${url.protocol === "https:" ? "http" : "https"}://${url.host}`];
      const configured = configuredAppOrigin();
      if (configured && URL.canParse(configured)) {
        ownOrigins.push(new URL(configured).origin);
      }

      let source: Awaited<ReturnType<typeof fetchSourceImage>>;
      try {
        source = await fetchSourceImage(rawImageUrl, {
          ownOrigins,
          localOrigin: `http://localhost:${process.env.PORT || 5173}`,
          allowedHosts: manager.allowedHosts,
          maxSize: manager.maxSize,
          timeout: manager.timeout,
        });
      } catch (error) {
        if (error instanceof ImageSourceError) {
          return errorResponse(error.status, error.message);
        }
        throw error;
      }

      let buffer: Buffer;
      try {
        buffer = await manager.resize(source.bytes, {
          height,
          width,
          fit: fit as any,
          quality,
        });
      } catch {
        return errorResponse(415, "The image could not be decoded");
      }

      const headers = new Headers({
        "Content-Type": "image/webp",
        "Content-Length": `${buffer.byteLength}`,
      });
      if (source.cacheControl) headers.set("Cache-Control", source.cacheControl);
      return new Response(new Uint8Array(buffer), { headers });
    }),
  };
}

function errorResponse(status: number, error: string) {
  return Response.json({ error }, { status });
}

export class ImageManager {
  static token = "image";

  readonly driver: ImageOptimizationDriver;
  readonly allowedHosts: readonly string[];
  readonly maxSize: number;
  readonly timeout: number;

  constructor(config: ImageConfig = {}) {
    const defaults = imageConfigDefaults();
    this.driver = config.driver ?? defaults.driver;
    this.allowedHosts = config.allowedHosts ?? defaults.allowedHosts;
    this.maxSize = config.maxSize ?? defaults.maxSize;
    this.timeout = config.timeout ?? defaults.timeout;
  }

  resize(buffer: Buffer, params: ResizeParameters) {
    return this.driver.resize(buffer, params);
  }
}
