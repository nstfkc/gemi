import { RateLimiterDriver } from "./RateLimiterDriver";

export class InMemoryRateLimiter extends RateLimiterDriver {
  requests: Map<string, { date: number; count: number }> = new Map();

  consume(id: string, path: string) {
    if (!this.requests.has(id)) {
      this.requests.set(id, { date: Date.now(), count: 1 });
    } else {
      const record = this.requests.get(id);
      const now = Date.now();
      if (now - record.date >= 1000 * 60) {
        this.requests.set(id, { date: now, count: 1 });
      } else {
        this.requests.set(id, { date: record.date, count: record.count + 1 });
      }
    }

    return this.requests.get(id).count;
  }
}
