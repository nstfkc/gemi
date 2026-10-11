# Cache

`Cache` keeps the results of expensive work (a model call, a slow query, a third-party API) for a while, so the next request reads them instead of redoing it. Values live in a **store**: this process's memory by default, or Redis, shared by every instance of the app.

```typescript
import { Cache } from "gemi/facades";

const plan = await Cache.remember(`plan:${hash}`, "24h", () => planner.plan(input));
```

## Configuration

Nothing to set up for one instance: with no `app/config/cache.ts` the cache is in memory, with no default expiry. To change that, add the slice and list it on your kernel:

```typescript
// app/config/cache.ts
import { defineCacheConfig } from "gemi/services";

export default defineCacheConfig({
  // "memory" (default) | "redis" | a CacheStore | (app) => CacheStore
  store: "redis",

  // How long a value lives when a call does not say. Default null: no expiry.
  ttl: "1h",

  // The "redis" store's key prefix (default "gemi:cache:"). Give each app and
  // each environment sharing one Redis its own.
  redis: { prefix: "myapp:prod:cache:" },

  // The "memory" store's size: least recently used entries go first.
  memory: { maxEntries: 10_000 },
});
```

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import cache from "../config/cache";

export default class extends Kernel {
  config = { cache /* , ...the other slices */ };
}
```

The `"redis"` store uses the app's own Redis connection: `app/config/redis.ts`, else `REDIS_URL` (see [Facades: Redis](./facades.md#redis)). It opens no connection until the first cache call.

### Which store

| | `"memory"` (`MemoryCacheStore`) | `"redis"` (`RedisCacheStore`) |
| --- | --- | --- |
| Shared between instances | No: each process keeps its own | Yes |
| A `delete` or tag `flush` reaches | This process only | Every instance, on its next read |
| Survives a restart / deploy | No | Yes |
| Bounded by | `maxEntries`, least recently used first | Redis's own memory policy |

Memory is right for results that are expensive to make and fine to serve slightly stale on another instance until they expire. Anything that must be evicted everywhere at once (a permission, a plan, a session) wants Redis as soon as the app runs on more than one instance.

## Reading and writing

```typescript
import { Cache } from "gemi/facades";

await Cache.set("rates:EUR", rates, "10m");
const rates = await Cache.get<Rates>("rates:EUR"); // undefined on a miss
await Cache.has("rates:EUR");
await Cache.delete("rates:EUR");                    // true when something was removed
const once = await Cache.pull<string>("invite:abc"); // read and remove
await Cache.flush();                                 // everything in the store
```

### TTL

A TTL is milliseconds, or a number and a unit: `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"7d"`, `"1w"`. Omitted, the slice's `ttl` applies; `null` stores without expiry whatever the default is; `0` stores nothing and removes what was there.

### Values are JSON

Every store, the memory one included, keeps values JSON-encoded, so an app behaves the same in development (memory) and in production (Redis):

- What comes back is what a JSON round trip gives: a `Date` is its ISO string, a class instance a plain object, a `Map` an empty object.
- Changing an object `get` returned does not change what is cached.
- `undefined` cannot be stored, because `get` returns it for a miss. `null` can, and `has` reports it.

## remember

`remember(key, ttl, compute)` returns the cached value, or runs `compute`, stores what it resolves and returns it:

```typescript
const user = await Cache.remember(`github:${login}`, "1h", () => github.user(login));
const stats = await Cache.remember("stats", () => loadStats()); // the default ttl
```

- Concurrent calls for one key **in one process** that all miss share a single `compute`: a burst of requests for a cold key does the work once per instance.
- A `compute` that throws stores nothing; every caller waiting on it gets the error, and the next call tries again.
- A `compute` that resolves `undefined` stores nothing.

## Tags

Tags group values so they can be dropped together, on any store:

```typescript
const billing = await Cache.tags(`user:${user.id}`).remember(
  `billing:${user.id}`,
  "5m",
  () => loadBilling(user.id),
);

// In the Stripe webhook:
await Cache.tags(`user:${customer.userId}`).flush();
```

- A value written under tags is reachable only through the same set of tags, in any order: `Cache.tags("a", "b")` and `Cache.tags(["b", "a"])` are the same view; `Cache.get(key)` and `Cache.tags("a").get(key)` are not.
- `flush()` on a tagged view drops every value written under **any** of its tags, including ones written with more tags.
- Each tag has a version kept in the store, and a tagged value's key includes its tags' versions. `flush()` replaces the versions, so the old values become unreachable at once on every instance sharing the store; they are not deleted, and leave by their TTL (or, in memory, by eviction). **Give tagged values a TTL on Redis.**
- Reading a tagged value costs one extra store read per tag.

## Using a cache of your own

`CacheManager` is a plain class, so a part of the app can keep a cache apart from the application's:

```typescript
import { CacheManager, MemoryCacheStore } from "gemi/services";

const previews = new CacheManager({
  store: new MemoryCacheStore({ maxEntries: 2_000 }),
  ttl: "24h",
});
await previews.remember(key, () => render(page));
```

## Writing a store

A store implements `CacheStore` from `gemi/services`: four async methods on strings. The manager does the JSON, the TTL parsing, `remember` and tags on top of them.

```typescript
import type { CacheStore } from "gemi/services";

class MemcachedStore implements CacheStore {
  async get(key: string): Promise<string | null> { /* null on a miss */ }
  async set(key: string, value: string, ttlMs: number | null): Promise<void> { /* null: no expiry */ }
  async delete(key: string): Promise<boolean> { /* whether something was removed */ }
  async flush(): Promise<void> { /* everything this store owns */ }
}
```

Pass an instance, or a function that builds one from the application, as `store`.

## Errors

The Redis store does not swallow errors: a failed `delete` that looked like a success would leave a stale value in place, so the call rejects with Redis's error. Wrap a read in `try/catch` where serving without the cache is better than failing.

## Related

- [Facades](./facades.md) for `Redis`, the raw client.
- [Middleware: rate limiting](./middleware.md#rate-limiting), which has its own memory and Redis drivers.
- [Project Structure](./project-structure.md) for config slices.
