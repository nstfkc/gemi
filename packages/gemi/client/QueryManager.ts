import { Subject } from "../utils/Subject";
import { applyParams } from "../utils/applyParams";

type State = {
  data: any;
  error: any;
  loading: boolean;
};

class Resource {
  key: string;
  state: Subject<State>;
  lastFetchedAt: number;
  stale: boolean = false;

  constructor(key: string, fallbackData: any = null) {
    this.key = key;
    this.state = new Subject({
      data: fallbackData,
      error: null,
      loading: false,
    });

    this.lastFetchedAt = fallbackData ? Date.now() : 0;
  }

  mutate<T>(fn: (data: T) => T) {
    const data = fn(this.state.getValue().data);
    this.state.next({
      data,
      error: null,
      loading: false,
    });
    this.stale = true;
    this.fetch();
  }

  fetch() {
    const { loading, data, error } = this.state.getValue();
    const expired = Date.now() - this.lastFetchedAt > 1000 * 10;
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
      if (this.stale || expired) {
        this.resolve();
      }
    }

    return this.state;
  }

  resolve() {
    const { key, options } = JSON.parse(this.key);
    const { search, params } = options;
    const url = key.split("GET:")[1];
    const searchParams = new URLSearchParams(search);
    searchParams.sort();
    const finalUrl = [applyParams(url, params), searchParams.toString()]
      .filter((s) => s.length > 0)
      .join("?");

    const { data, error } = this.state.getValue();

    this.state.next({
      data,
      error,
      loading: true,
    });

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
        this.state.next({
          data,
          error: null,
          loading: false,
        });
        this.lastFetchedAt = Date.now();
        this.stale = false;
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
