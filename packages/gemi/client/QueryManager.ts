import { Subject } from "../utils/Subject";

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out.replace(`:${key}?`, value);
    out.replace(`:${key}`, value);
  }
  return out;
}

type State = {
  data: any;
  error: any;
  loading: boolean;
};

class Resource {
  key: string;
  state: Subject<State> = new Subject({
    data: null,
    error: null,
    loading: false,
  });
  stale = true;

  constructor(key: string) {
    this.key = key;
  }

  mutate<T>(fn: (data: T) => T) {
    const data = fn(this.state.getValue().data);
    this.state.next({
      data,
      error: null,
      loading: false,
    });
  }

  fetch() {
    const { loading, data, error } = this.state.getValue();
    if (!this.stale) {
      return this.state;
    }
    if (!loading && this.stale) {
      this.state.next({
        data,
        error,
        loading: true,
      });
      this.resolve();
    }

    return this.state;
  }

  resolve() {
    const { key, query, params } = JSON.parse(this.key);
    const url = key.split(":")[1];
    const searchParams = new URLSearchParams(query);
    const finalUrl = [applyParams(url, params), searchParams.toString()]
      .filter((s) => s.length > 0)
      .join("?");

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
        this.stale = false;
        this.mutate(() => data);
      })
      .catch((err) => {
        this.state.next({
          data: null,
          error: err,
          loading: false,
        });
      });
  }
}

export class QueryManager {
  resources: Map<string, Resource> = new Map();

  constructor() {}

  private createResourceKey(key: string, options: Record<string, any> = {}) {
    return JSON.stringify({ key, options });
  }

  fetch(key: string, options: Record<string, any> = {}) {
    const resourceKey = this.createResourceKey(key, options);

    if (!this.resources.has(resourceKey)) {
      this.resources.set(resourceKey, new Resource(resourceKey));
    }

    const resource = this.resources.get(resourceKey);

    resource.fetch.call(resource);

    return resource;
  }
}
