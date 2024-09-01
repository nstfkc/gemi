import { RateLimiterServiceProvider } from "./RateLimiterServiceProvider";

export class RateLimiterServiceContainer {
  constructor(public service: RateLimiterServiceProvider) {}
}
