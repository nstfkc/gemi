import { useLocation } from "./ClientRouterContext";
import { useNavigate } from "./useNavigate";

type SearchParamsCallback = (
  search: Record<string, any>,
  shallow: boolean,
) => void;

class SearchParams {
  constructor(
    private searchParams: URLSearchParams,
    private callback: SearchParamsCallback,
  ) {}

  get(key: string) {
    return this.searchParams.get(key);
  }

  set(key: Record<string, string | ((state: string) => string)>): SearchParams;
  set(key: string, value: string | ((state: string) => string)): SearchParams;
  set(key: any, value?: any) {
    let entries: Record<string, any> = {};
    if (typeof key === "string") {
      let _value: string = value;
      if (typeof value === "function") {
        _value = value(this.get(key) ?? "");
      }
      entries[key] = _value;
    } else {
      entries = (key as any) ?? {};
    }
    for (const [key, value] of Object.entries(entries)) {
      let _value: string = value;
      if (typeof value === "function") {
        _value = value(this.get(key) ?? "");
      }
      this.searchParams.set(key, _value);
    }
    return this;
  }

  append(key: string, value: string) {
    this.searchParams.append(key, value);
    return this;
  }

  sort() {
    this.searchParams.sort();
    return this;
  }

  clear() {
    this.searchParams = new URLSearchParams();
    return this;
  }

  delete(key: string | string[]) {
    const keys = Array.isArray(key) ? key : [key];
    for (const key of keys) {
      this.searchParams.delete(key);
    }
    return this;
  }

  toJSON() {
    return Object.fromEntries(this.searchParams.entries());
  }

  toString() {
    return this.searchParams.toString();
  }

  push(mode: "soft" | "hard" = "soft") {
    this.callback(this.toJSON(), mode === "soft");
  }
}

export function useSearchParams() {
  const { push } = useNavigate();
  const location = useLocation();
  const callback = (search: Record<string, any>, shallow: boolean) => {
    push(location.pathname as never, {
      search,
      shallow,
    });
  };

  const searchParams = new SearchParams(
    new URLSearchParams(location.search),
    callback,
  );

  return searchParams;
}
