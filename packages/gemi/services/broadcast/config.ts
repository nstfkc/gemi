import type { Application } from "../../foundation/Application";
import type { BroadcastDriver } from "./BroadcastDriver";

// Config key: `broadcast` (`app/config/broadcast.ts`).
export interface BroadcastConfig {
  /**
   * Which processes see an emit: `"memory"`, a `BroadcastDriver`, or a
   * function returning one, called once with the application.
   *
   * `"memory"` is the default and reaches the sockets of **this process
   * only**: right for one instance whose web processes also run the jobs,
   * wrong for several replicas or a separate `gemi queue:work` worker. See
   * `MemoryBroadcastDriver`.
   */
  driver?: "memory" | BroadcastDriver | ((application: Application) => BroadcastDriver);

  /**
   * The largest event frame, in bytes, JSON-encoded with its topic and name.
   * A bigger emit throws `BroadcastPayloadTooLargeError` at the call site.
   * Default `16384` (16 KB). Send ids and a change hint, and let the client
   * fetch the data over HTTP.
   */
  maxEventBytes?: number;

  /**
   * Frames above this size log a warning, once per event name. Default
   * `4096` (4 KB). `false` turns the warning off.
   */
  warnEventBytes?: number | false;
}

export function defineBroadcastConfig(config: BroadcastConfig): BroadcastConfig {
  return config;
}

export function broadcastConfigDefaults(): Required<BroadcastConfig> {
  return {
    driver: "memory",
    maxEventBytes: 16 * 1024,
    warnEventBytes: 4 * 1024,
  };
}
