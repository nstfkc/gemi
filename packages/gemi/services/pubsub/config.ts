import type { BroadcastingChannel } from "../../broadcasting/BroadcastingChannel";

// Config key: `broadcast`. Derived from `BroadcastingServiceProvider`.
export interface BroadcastConfig {
  channels?: Record<string, new () => BroadcastingChannel>;
}

export function defineBroadcastConfig(
  config: BroadcastConfig,
): BroadcastConfig {
  return config;
}

export function broadcastConfigDefaults(): Required<BroadcastConfig> {
  return {
    channels: {},
  };
}
