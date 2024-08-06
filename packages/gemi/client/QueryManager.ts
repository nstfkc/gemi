import { Subject } from "../utils/Subject";

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const segment of url.split("/")) {
    if (segment.includes(":")) {
      const key = segment.split(":")[1];
      out = out.replace(`:${key}`, params[key]);
    }
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
  state: Subject<State>;
  stale = true;
  staleTimer: Timer | null = null;

  constructor(key: string, fallbackData: any = null) {
    this.key = key;
    this.state = new Subject({
      data: fallbackData,
      error: null,
      loading: false,
    });
    if (fallbackData) {
      this.stale = false;
    }
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

    if (loading) {
      return this.state;
    }

    if (!data) {
      this.state.next({
        data,
        error,
        loading: true,
      });
      this.resolve();
    } else {
      if (this.stale) {
        this.resolve();
        return this.state;
      }
    }

    return this.state;
  }

  resolve() {
    const { key, options } = JSON.parse(this.key);
    const { query, params } = options;
    const url = key.split("GET:")[1];
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
        clearTimeout(this.staleTimer);
        this.staleTimer = setTimeout(() => {
          this.stale = true;
        }, 1000 * 60);
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

  fetch(
    key: string,
    options: Record<string, any> = {},
    config: Record<string, any> = {},
  ) {
    const resourceKey = this.createResourceKey(key, options);

    if (!this.resources.has(resourceKey)) {
      this.resources.set(
        resourceKey,
        new Resource(resourceKey, config.fallbackData),
      );
    }

    const resource = this.resources.get(resourceKey);

    resource.fetch.call(resource);

    return resource;
  }
}
