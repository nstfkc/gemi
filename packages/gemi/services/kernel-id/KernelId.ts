/**
 * Identifies one booted kernel process. The client compares it across
 * navigations to detect a server restart, so it must be stable for the life of
 * the process and different after a reboot.
 */
export class KernelId {
  static token = "kernel.id";

  constructor(public readonly id: string = crypto.randomUUID()) {}
}
