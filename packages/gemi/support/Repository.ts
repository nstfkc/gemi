// Runtime configuration store, modeled on `Illuminate\Config\Repository`.
// Keys are dot paths ("mail.driver", "route.view.rootRouter") resolved against
// a plain nested object. This is the RUNTIME config; `gemi/config` is the
// BUILD config (gemi.config.ts) and is unrelated.

export type ConfigItems = Record<string, any>;

function segments(key: string): string[] {
  return key.split(".");
}

export class Repository {
  // Container token. The Kernel binds its Repository under `config`, so any
  // provider can `app.make(Repository)` — though `this.app.config` is shorter.
  static token = "config";

  private items: ConfigItems;

  constructor(items: ConfigItems = {}) {
    this.items = items;
  }

  has(key: string): boolean {
    let target: any = this.items;
    for (const segment of segments(key)) {
      if (target === null || typeof target !== "object" || !(segment in target)) {
        return false;
      }
      target = target[segment];
    }
    return true;
  }

  get<T = any>(key: string, defaultValue?: T): T {
    let target: any = this.items;
    for (const segment of segments(key)) {
      if (target === null || typeof target !== "object" || !(segment in target)) {
        return defaultValue as T;
      }
      target = target[segment];
    }
    return target === undefined ? (defaultValue as T) : (target as T);
  }

  // Reads many keys at once. Accepts either a list of keys or a
  // `{ key: defaultValue }` map, mirroring `Repository::getMany`.
  getMany(keys: string[] | Record<string, any>): Record<string, any> {
    const entries: Array<[string, any]> = Array.isArray(keys)
      ? keys.map((key): [string, any] => [key, undefined])
      : Object.entries(keys);

    const result: Record<string, any> = {};
    for (const [key, defaultValue] of entries) {
      result[key] = this.get(key, defaultValue);
    }
    return result;
  }

  set(key: string | Record<string, any>, value?: any): void {
    const entries: Array<[string, any]> =
      typeof key === "string" ? [[key, value]] : Object.entries(key);

    for (const [path, item] of entries) {
      const parts = segments(path);
      const last = parts.pop() as string;

      let target: any = this.items;
      for (const segment of parts) {
        const next = target[segment];
        if (next === null || typeof next !== "object") {
          target[segment] = {};
        }
        target = target[segment];
      }

      target[last] = item;
    }
  }

  // Adds `value` to the front of the array stored at `key`.
  prepend(key: string, value: any): void {
    const array = this.get<any[]>(key, []);
    array.unshift(value);
    this.set(key, array);
  }

  // Adds `value` to the end of the array stored at `key`.
  push(key: string, value: any): void {
    const array = this.get<any[]>(key, []);
    array.push(value);
    this.set(key, array);
  }

  // Shallow-merges a `{ topLevelKey: config }` map into the store. Existing
  // top-level keys are merged one level deep so partial overrides compose.
  merge(items: ConfigItems): void {
    for (const [key, value] of Object.entries(items)) {
      const current = this.items[key];
      if (
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current) &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        this.items[key] = { ...current, ...value };
      } else {
        this.items[key] = value;
      }
    }
  }

  all(): ConfigItems {
    return this.items;
  }
}
