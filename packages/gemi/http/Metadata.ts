export type OpenGraphParams = {
  title: string;
  description?: string;
  type: string;
  url: string;
  image: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  twitterImage?: string;
  twitterImageAlt?: string;
  twitterImageWidth?: number;
  twitterImageHeight?: number;
};
export class Metadata {
  content: any = {
    title: "Gemi App",
    description: null,
    openGraph: null,
  };

  /**
   * Whether a handler set anything, as opposed to `content` still being the
   * defaults. A partially rendered response that touched no metadata sends
   * none, so the client keeps what the skipped segments put there.
   */
  touched = false;

  render() {
    return {
      title: this.content.title,
      description: this.content.description,
      openGraph: this.content.openGraph,
    };
  }

  title(title: string) {
    this.touched = true;
    this.content.title = title;
  }

  description(description: string) {
    this.touched = true;
    this.content.description = description;
  }

  openGraph({
    title,
    description,
    type,
    url,
    image,
    imageAlt,
    imageWidth,
    imageHeight,
    twitterImage = image,
    twitterImageAlt = imageAlt,
    twitterImageWidth = imageWidth,
    twitterImageHeight = imageHeight,
  }: OpenGraphParams) {
    this.touched = true;
    let _image = image;
    let _twitterImage = twitterImage;
    if (image && !image.startsWith("http")) {
      _image = `${process.env.HOST_NAME}${image}`;
      _twitterImage = `${process.env.HOST_NAME}${twitterImage}`;
    }
    this.content.openGraph = Object.fromEntries(
      Object.entries({
        title,
        description,
        type,
        url,
        image: _image,
        imageAlt,
        imageWidth,
        imageHeight,
        twitterImage: _twitterImage,
        twitterImageAlt,
        twitterImageWidth,
        twitterImageHeight,
      }).filter(([_, value]) => value !== undefined),
    );
  }
}
