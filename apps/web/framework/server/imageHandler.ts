import sharp, { type FitEnum } from "sharp";

export async function imageHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawImageUrl = url.searchParams.get("url");
  const width = Number(url.searchParams.get("w"));
  const height = Number(url.searchParams.get("h"));
  const fit = (url.searchParams.get("fit") ??
    "cover") as unknown as keyof FitEnum;
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

  const buffer = await sharp(imageBuffer)
    .resize(width > 0 ? width : undefined, height > 0 ? height : undefined, {
      fit,
    })
    .webp({ quality: quality > 0 ? quality : 80, force: true })
    .toBuffer();

  res.headers.delete("Content-Type");
  res.headers.delete("Content-Length");
  return new Response(buffer, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": `${buffer.byteLength}`,
      ...res.headers.toJSON(),
    },
  });
}
