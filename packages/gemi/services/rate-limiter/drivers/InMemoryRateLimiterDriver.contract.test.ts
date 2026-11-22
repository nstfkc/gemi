import { InMemoryRateLimiter } from "./InMemoryRateLimiterDriver";
import { rateLimiterDriverContract } from "./rateLimiterDriverContract";

// One instance is the storage: every "client" of it is the same object.
rateLimiterDriverContract("InMemoryRateLimiter", async () => {
  const limiter = new InMemoryRateLimiter();
  return { driver: () => limiter };
});
