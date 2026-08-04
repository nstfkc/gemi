import type { CronJob } from "./CronJob";

// Config key: `schedule`. Consumed by `ScheduleServiceProvider`.
export interface ScheduleConfig {
  jobs?: Array<new () => CronJob>;
}

export function defineScheduleConfig(config: ScheduleConfig): ScheduleConfig {
  return config;
}

export function scheduleConfigDefaults(): Required<ScheduleConfig> {
  return {
    jobs: [],
  };
}
