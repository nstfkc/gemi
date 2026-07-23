import { app } from "../../foundation/app";
import { ApiRouter, HttpRequest } from "../../http";
import { imageConfigDefaults, type ImageConfig } from "./config";
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
        return new Response(
          JSON.stringify({
            error: "url query parameter is required",
          }),
          {
            headers: {
              "Content-Type": "application/json",
            },
            status: 404,
          },
        );
      }
      const prefix = rawImageUrl.startsWith("http")
        ? ""
        : `http://localhost:${process.env.PORT || 5173}`;
      const fullImageUrl = `${prefix}${rawImageUrl}`;
      const res = await fetch(fullImageUrl);
      if (!res.ok) {
        return new Response(
          JSON.stringify({
            error: "Image not found",
            info: fullImageUrl,
          }),
          {
            headers: {
              "Content-Type": "application/json",
            },
            status: 404,
          },
        );
      }

      const imageBuffer = Buffer.from(await res.arrayBuffer());

      const buffer = await app(ImageManager).resize(imageBuffer, {
        height,
        width,
        fit: fit as any,
        quality,
      });

      res.headers.delete("Content-Type");
      res.headers.delete("Content-Length");
      const _headers = new Headers(res.headers);
      _headers.set("Content-Type", "image/webp");
      _headers.set("Content-Length", `${buffer.byteLength}`);
      return new Response(new Uint8Array(buffer), {
        headers: _headers,
      });
    }),
  };
}

export class ImageManager {
  static token = "image";

  readonly driver: ImageOptimizationDriver;

  constructor(config: ImageConfig = {}) {
    this.driver = config.driver ?? imageConfigDefaults().driver;
  }

  resize(buffer: Buffer, params: ResizeParameters) {
    return this.driver.resize(buffer, params);
  }
}
