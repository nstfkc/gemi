export function optimisedImage(params: {
  url: string;
  width: number;
  height: number;
  quality?: number;
}) {
  const urlSearchParams = new URLSearchParams();
  urlSearchParams.append("url", params.url);
  urlSearchParams.append("width", params.width.toString());
  urlSearchParams.append("height", params.height.toString());
  urlSearchParams.append("quality", (params.quality ?? 80).toString());
  return `/__gemi/image?${urlSearchParams.toString()}`;
}
