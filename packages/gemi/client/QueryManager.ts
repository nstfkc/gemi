import { Subject } from "../utils/Subject";

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out.replace(`:${key}?`, value);
    out.replace(`:${key}`, value);
  }
  return out;
}

class Resource {
  key: string;
  state: "stale" | "fresh" = "stale";
  data: Subject<any | null> = new Subject(null);

  constructor(key: string) {
    this.key = key;
  }

  mutate(data: any) {
    this.state = "fresh";
    this.data.next(data);
  }

  resolve() {
    const { url, query, params } = JSON.parse(this.key);
    const searchParams = new URLSearchParams(query);
    const finalUrl = `${applyParams(url, params)}?${searchParams.toString()}`;

    fetch(`/api${finalUrl}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    })
      .then((res) => {
        if (res.ok) {
          return res.json();
        } else {
          throw new Error("Failed to fetch");
        }
      })
      .then((data) => {
        this.mutate(data);
      })
      .catch((err) => {
        console.error(err);
      });
  }
}

export class QueryManager {
  resources: Map<string, Resource> = new Map();

  constructor() {}

  private createResourceKey(key: string, options: Record<string, any> = {}) {
    return JSON.stringify({ key, options });
  }

  getResource(key: string, options: Record<string, any> = {}) {
    const resourceKey = this.createResourceKey(key, options);
    if (!this.resources.has(resourceKey)) {
      this.resources.set(key, new Resource(resourceKey));
    }

    return this.resources.get(key);
  }
}
