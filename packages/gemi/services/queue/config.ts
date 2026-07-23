import type { Job } from "./Job";

// Config key: `queue`. Derived from `QueueServiceProvider`.
export interface QueueConfig {
  jobs?: Array<new () => Job>;
  concurrency?: number;
}

export function defineQueueConfig(config: QueueConfig): QueueConfig {
  return config;
}

export function queueConfigDefaults(): Required<QueueConfig> {
  return {
    jobs: [],
    concurrency: 1,
  };
}
