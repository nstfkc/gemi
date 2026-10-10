import type { BroadcastDeliver, BroadcastDriver } from "./BroadcastDriver";

/**
 * The default driver: an emit reaches the sockets of **this process only**.
 *
 * Right for one instance whose web processes also run the jobs and cron that
 * emit. Wrong as soon as there are two replicas, or a `gemi queue:work`
 * worker that emits: those frames reach nobody, with nothing to say so. Use
 * the Redis driver there.
 *
 * Before the HTTP server starts the transport, there is nobody to deliver to,
 * and `publish` drops the frame.
 */
export class MemoryBroadcastDriver implements BroadcastDriver {
  private deliver: BroadcastDeliver | null = null;

  /** Whether the transport has started this driver. */
  get started(): boolean {
    return this.deliver !== null;
  }

  publish(topic: string, frame: string): void {
    this.deliver?.(topic, frame);
  }

  start(deliver: BroadcastDeliver): void {
    this.deliver = deliver;
  }

  close(): void {
    this.deliver = null;
  }
}
