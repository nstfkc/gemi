export class Metadata {
  content: any = {
    title: "Gemi App",
    description: null,
    openGraph: null,
  };

  render() {
    return {
      title: this.content.title,
      description: this.content.description,
    };
  }

  title(title: string) {
    this.content.title = title;
  }

  description(description: string) {
    this.content.description = description;
  }

  openGraph(title: string, description: string, image: string, url: string) {
    this.content.openGraph = {
      title,
      description,
      image,
      url,
    };
  }
}
