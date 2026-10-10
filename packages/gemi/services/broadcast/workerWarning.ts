import type { Application } from "../../foundation/Application";
import type { BroadcastConfig } from "./config";
import { MemoryBroadcastDriver } from "./MemoryBroadcastDriver";

/**
 * What `gemi queue:work` warns at boot when the app declares channels but
 * broadcasts with the memory driver, or `null`. A worker has no sockets, so
 * with the memory driver its jobs' emits reach no one, with nothing else to
 * say so. A warning, not a refusal as for a memory queue: the worker still
 * runs its jobs, only their broadcasts are lost.
 */
export function memoryBroadcastInWorker(application: Application): string | null {
  if (!application.config.get("route.channels")) return null;
  const driver = application.config.get<BroadcastConfig>("broadcast", {}).driver;
  const memory =
    driver === undefined || driver === "memory" || driver instanceof MemoryBroadcastDriver;
  if (!memory) return null;
  return (
    "[gemi] Broadcasts from this worker reach no one: the broadcast driver is " +
    '"memory", which delivers to the sockets of the process that emits, and a ' +
    'worker has none. Set `driver: "redis"` in app/config/broadcast.ts.'
  );
}
