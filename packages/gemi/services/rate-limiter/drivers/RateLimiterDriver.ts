export abstract class RateLimiterDriver {
  abstract consume(userId: string, requestPath: string): number;
}
