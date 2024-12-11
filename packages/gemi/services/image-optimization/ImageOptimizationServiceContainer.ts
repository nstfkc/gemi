import { ApiRouter, HttpRequest } from "../../http";
import { ServiceContainer } from "../ServiceContainer";
import { ImageOptimizationServiceProvider } from "./ImageOptimizationServiceProvider";

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

      console.log({ rawImageUrl });

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
      console.log({ fullImageUrl });

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

      const buffer =
        await ImageOptimizationServiceContainer.use().service.driver.resize(
          imageBuffer,
          { height, width, fit: fit as any, quality },
        );

      res.headers.delete("Content-Type");
      res.headers.delete("Content-Length");
      return new Response(buffer, {
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": `${buffer.byteLength}`,
          ...res.headers.toJSON(),
        },
      });
    }),
  };
}

export class ImageOptimizationServiceContainer extends ServiceContainer {
  static _name = "ImageOptimizationServiceContainer";

  constructor(public service: ImageOptimizationServiceProvider) {
    super();
  }
}
