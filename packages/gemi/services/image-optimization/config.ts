import type { ImageOptimizationDriver } from "./drivers/ImageOptimizationDriver";
import { Sharp } from "./drivers/SharpDriver";

// Config key: `image`.
export interface ImageConfig {
  driver?: ImageOptimizationDriver;
  /**
   * Hosts other than the app's own that the resize route (and so `<Image>`)
   * may fetch source images from: host names (`"cdn.example.com"`, or
   * `"*.example.com"` for its subdomains) or IP ranges, as `safeFetch`'s
   * `allow`. Each must still resolve to a public address, on port 80 or 443.
   * Default `[]`: only paths and URLs on the app's own origin.
   */
  allowedHosts?: readonly string[];
  /** Largest source image fetched, in bytes. Default 10 MiB. */
  maxSize?: number;
  /** The whole fetch of a source image, redirects and body, in ms. Default 10 000. */
  timeout?: number;
}

export function defineImageConfig(config: ImageConfig): ImageConfig {
  return config;
}

export function imageConfigDefaults(): Required<ImageConfig> {
  return {
    driver: new Sharp(),
    allowedHosts: [],
    maxSize: 10 * 1024 * 1024,
    timeout: 10_000,
  };
}
