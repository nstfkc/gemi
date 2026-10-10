import type { Application } from "../../foundation/Application";
import type { BroadcastDriver } from "./BroadcastDriver";
import { DEFAULT_SOCKET_PATH } from "./protocol";

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

  /**
   * The WebSocket endpoint, on the app's own origin. Default
   * `"/__gemi/socket"`. Change it on the client too:
   * `init(RootLayout, { realtime: { path } })`.
   */
  path?: string;

  /**
   * Origins allowed to open a socket, besides the app's own (the request's
   * own host, and `APP_URL` / `HOST_NAME`). An entry is an origin
   * (`"https://app.example.com"`), a bare host (`"app.example.com"`), or a
   * wildcard for a host's subdomains (`"*.example.com"`,
   * `"https://*.example.com"`), which does not admit the host itself.
   *
   * Subdomains are never allowed by default, `route.domains` ones included:
   * a tenant's subdomain is same-site with the app, so the app's cookies ride
   * along with its upgrade, and a WebSocket has no CORS. List a wildcard only
   * for subdomains whose pages you trust. A cookie-carrying upgrade without
   * an `Origin` header is refused, and so is any upgrade from an origin not
   * allowed.
   */
  allowedOrigins?: string[];

  /** Open sockets per process. Upgrades past it get a `503`. Default `10000`. */
  maxConnectionsPerProcess?: number;

  /**
   * Open sockets per client IP, per process. Default `100`. The address is
   * the TCP peer unless `GEMI_TRUST_PROXY` says which `X-Forwarded-For` entry
   * to believe: behind a proxy without it, every client shares the proxy's
   * address and this caps the whole app per process (the server warns at
   * boot).
   */
  maxConnectionsPerIp?: number;

  /** Open sockets per signed-in user, per process. Default `50`. */
  maxConnectionsPerUser?: number;

  /** Subscriptions per socket. Past it a `sub` is denied with `limit`. Default `50`. */
  maxChannelsPerSocket?: number;

  /** The largest frame a client may send, in bytes. Default `16384`. */
  maxInboundMessageBytes?: number;

  /**
   * How many bytes may queue up for one socket before it is closed with
   * `1013`; the client reconnects and refetches. No queue is kept per
   * socket beyond this. Default `1048576` (1 MB).
   */
  backpressureLimit?: number;

  /**
   * Seconds without a frame or a pong before Bun closes a socket. Bun pings
   * idle sockets on its own. Default `120`.
   */
  idleTimeout?: number;

  /**
   * How often the client pings, in ms, sent to it in `hello`. A client that
   * hears nothing for twice this reconnects, so a connection a proxy dropped
   * silently is noticed within about a minute. Default `25000`.
   */
  heartbeatMs?: number;

  /**
   * `sub` frames a socket may send per window (an `unsub` is not counted).
   * Past it a `sub` is denied with `rate_limited`, which the client retries
   * on the same socket after a few seconds; at twice it the socket is closed
   * with `1008`. Default `{ limit: 300, windowMs: 60000 }`.
   */
  subscribeRate?: { limit: number; windowMs: number };
}

export function defineBroadcastConfig(config: BroadcastConfig): BroadcastConfig {
  return config;
}

export function broadcastConfigDefaults(): Required<BroadcastConfig> {
  return {
    driver: "memory",
    maxEventBytes: 16 * 1024,
    warnEventBytes: 4 * 1024,
    path: DEFAULT_SOCKET_PATH,
    allowedOrigins: [],
    maxConnectionsPerProcess: 10_000,
    maxConnectionsPerIp: 100,
    maxConnectionsPerUser: 50,
    maxChannelsPerSocket: 50,
    maxInboundMessageBytes: 16 * 1024,
    backpressureLimit: 1 << 20,
    idleTimeout: 120,
    heartbeatMs: 25_000,
    subscribeRate: { limit: 300, windowMs: 60_000 },
  };
}
