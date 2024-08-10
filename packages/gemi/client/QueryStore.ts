type State = {
  data: any;
  createdAt: number;
};

export class QueryStore {
  store: Map<string, State>;

  async resolve(url: string, fresh = false) {
    if (!this.store.has(url)) {
      this.store.set(url, {
        createdAt: Date.now(),
        data: null,
      });
    }
    const state = this.store.get(url);

    if (state.createdAt < Date.now() - 1000 * 60) {
      if (!fresh && state.data) {
        return state.data;
      }
    }

    const response = await fetch(url);

    if (response.ok) {
      const data = await response.json();
      this.store.set(url, {
        data,
        createdAt: Date.now(),
      });
      return data;
    }
  }
}
