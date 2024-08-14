type State = {
  data: any;
  error: any;
  status: "idle" | "pending" | "resolved" | "rejected";
  createdAt: number;
};

export class QueryStore {
  store = new Map<string, State>();

  async resolve(url: string, fresh = false) {
    if (!this.store.has(url)) {
      this.store.set(url, {
        createdAt: Date.now(),
        data: null,
        error: null,
        status: "idle",
      });
    }

    const state = this.store.get(url);

    if (state.createdAt < Date.now() - 1000 * 60) {
      if (!fresh && state.data) {
        return { data: state.data, error: state.error };
      }
    }

    if (state.status === "pending") {
      while (true) {
        if (this.store.get(url)?.status === "pending") {
          break;
        }
      }
      return {
        data: this.store.get(url)?.data,
        error: this.store.get(url)?.error,
      };
    }

    const response = await fetch(url);

    if (response.ok) {
      const data = await response.json();
      this.store.set(url, {
        data,
        createdAt: Date.now(),
        status: "resolved",
        error: null,
      });
      return { data, error: null };
    } else {
      const error = await response.json();
      this.store.set(url, {
        data: null,
        createdAt: Date.now(),
        status: "rejected",
        error,
      });
      return { data: null, error };
    }
  }
}
