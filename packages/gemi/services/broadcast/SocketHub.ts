import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

import type { Application } from "../../foundation/Application";
import { signedInUser } from "../../http/ChannelRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { type CarriedContext, RequestContext } from "../../http/requestContext";
import { kernelContext } from "../../kernel/context";
import { isShuttingDown } from "../../server/shutdown";
import { runGlobalMiddleware } from "../router/globalMiddleware";
import type { BroadcastRevocation } from "./BroadcastDriver";
import type { BroadcastManager } from "./BroadcastManager";
import {
  BROADCAST_PROTOCOL,
  CloseCode,
  SUBSCRIPTION_ID,
  type DeniedCode,
  type ServerFrame,
} from "./protocol";
import { newSocketId, socketTag } from "./socketTag";

/** What the hub keeps on each of its sockets (`ws.data`). */
export interface GemiSocketData {
  /** Marks a broadcast socket, as opposed to the dev server's HMR relay. */
  readonly gemiSocket: true;
  /** The hub that accepted it. After a dev reload that may not be the current one. */
  readonly hub: SocketHub;
  readonly socketId: string;
  readonly tag: string;
  /** The upgrade request, kept to rebuild a request context for every `sub`. */
  readonly request: { url: string; headers: [string, string][] };
  /** What the global middleware resolved for the upgrade: its user. */
  readonly carried: CarriedContext | null;
  /** The signed-in user's id at the upgrade, for limits and `revoke({ user })`. */
  readonly userId: string | null;
  readonly ip: string | null;
  /** Subscription id → its topic, `null` while it is being authorized. */
  readonly subs: Map<string, Subscription>;
  /** Topic → how many of this socket's subscriptions are on it. */
  readonly topics: Map<string, number>;
  rate: { windowStart: number; subs: number; pings: number };
  /**
   * The process, IP and user connection counts this socket holds. Taken
   * before the upgrade's first `await`, so concurrent upgrades cannot
   * overshoot the caps, and given back exactly once.
   */
  reservation: Reservation | null;
  /** The hub has closed it (backpressure, revoke, bye); its close is on the way. */
  closing: boolean;
  closed: boolean;
}

interface Subscription {
  pattern: string;
  params: Record<string, string | number>;
  topic: string | null;
}

interface Reservation {
  ip: string | null;
  userId: string | null;
}

/** Pings a socket may send per `subscribeRate` window before it is closed (1008). */
const PING_LIMIT_PER_WINDOW = 120;
/** How often a subscription is authorized again when revocations keep landing. */
const MAX_AUTHORIZE_ATTEMPTS = 3;

type GemiSocket = ServerWebSocket<GemiSocketData>;

/**
 * The WebSocket side of broadcasting, one per HTTP server process: accepts
 * upgrades on the configured path, speaks the `gemi.v1` protocol (see
 * `protocol.ts`), authorizes every subscription through the app's
 * `ChannelRouter`, and delivers what the driver hands it with
 * `server.publish`.
 *
 * Nothing here keeps a queue or a log. A socket that falls behind is closed
 * (`1013`), one whose user signs out is closed (`4001`), and a server that
 * stops says `bye` (`1012`); in every case the client reconnects and
 * refetches what it shows.
 */
export class SocketHub {
  static token = "broadcast.sockets";

  private server: Server<GemiSocketData> | null = null;
  private readonly sockets = new Set<GemiSocket>();
  private readonly byTopic = new Map<string, Set<GemiSocket>>();
  private readonly topicReady = new Map<string, Promise<void>>();
  private readonly perIp = new Map<string, number>();
  private readonly perUser = new Map<string, number>();
  /** Sockets held or being upgraded: the process cap's count. */
  private connections = 0;
  /** Bumped by every topic revocation; see `revokedAt`. */
  private revocationSeq = 0;
  /** Topic → the `revocationSeq` of its last revocation. */
  private readonly revokedAt = new Map<string, number>();
  private closing = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly manager: BroadcastManager,
    private readonly application: Application,
  ) {}

  private get config() {
    return this.manager.config;
  }

  /** Whether `req` is for the socket endpoint (an upgrade or not). */
  matches(req: Request): boolean {
    try {
      return new URL(req.url).pathname === this.config.path;
    } catch {
      return false;
    }
  }

  /** Sockets open on this process. */
  get size(): number {
    return this.sockets.size;
  }

  /**
   * Starts delivering: the driver's frames for this process go out with
   * `server.publish`. Call once the server is listening.
   */
  start(server: Server<any>): Promise<void> {
    this.server = server as Server<GemiSocketData>;
    this.startPromise ??= this.manager
      .start((topic, frame) => this.deliver(topic, frame), {
        onGap: () => this.sendAll({ op: "gap" }),
        onRevoke: (revocation) => this.applyRevocation(revocation),
      })
      .catch((error) => {
        this.startPromise = null;
        console.error("[gemi] The broadcast driver could not start; events reach no socket.", error);
      });
    return this.startPromise;
  }

  /**
   * Answers a request for the socket endpoint: upgrades it, or refuses it
   * with a status saying why. `undefined` once Bun has taken it over.
   */
  upgrade(req: Request, server: Server<any>): Promise<Response | undefined> {
    return this.run(() => this.tryUpgrade(req, server as Server<GemiSocketData>));
  }

  private async tryUpgrade(
    req: Request,
    server: Server<GemiSocketData>,
  ): Promise<Response | undefined> {
    if (this.closing || isShuttingDown()) {
      return refuse(503, "The server is restarting.", { "Retry-After": "5" });
    }
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return refuse(426, "This endpoint only accepts WebSocket upgrades.", {
        Upgrade: "websocket",
      });
    }
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim());
    if (!protocols.includes(BROADCAST_PROTOCOL)) {
      return refuse(400, `Open the socket with the "${BROADCAST_PROTOCOL}" subprotocol.`);
    }
    const origin = this.checkOrigin(req);
    if (origin !== true) return refuse(403, origin);
    if (this.connections >= this.config.maxConnectionsPerProcess) {
      return refuse(503, "Too many connections.", { "Retry-After": "10" });
    }
    const ip = clientIp(req, server);
    if (ip && (this.perIp.get(ip) ?? 0) >= this.config.maxConnectionsPerIp) {
      return refuse(429, "Too many connections from this address.", { "Retry-After": "30" });
    }
    // Counted now, before the first `await`: checks made while another
    // upgrade's middleware or session lookup is pending see it.
    const reservation = this.reserve(ip);
    let handedOver = false;
    try {
      const response = await this.authenticate(req, server, reservation);
      handedOver = response === undefined;
      return response;
    } finally {
      if (!handedOver) this.release(reservation);
    }
  }

  private async authenticate(
    req: Request,
    server: Server<GemiSocketData>,
    reservation: Reservation,
  ): Promise<Response | undefined> {
    // The global middleware covers the endpoint as it covers every route: a
    // gate that refuses a request refuses its socket.
    const outcome = await runGlobalMiddleware(req);
    if (outcome.refusal) return outcome.refusal;
    const carried = outcome.carried;
    if (this.closing || isShuttingDown()) {
      return refuse(503, "The server is restarting.", { "Retry-After": "5" });
    }

    let user: unknown;
    try {
      const httpRequest = new HttpRequest(req, {}, "api", this.config.path);
      user = await RequestContext.run(
        httpRequest,
        async () => {
          const ctx = RequestContext.getStore();
          try {
            return await signedInUser(httpRequest);
          } finally {
            ctx.destroy();
          }
        },
        carried,
      );
    } catch (error) {
      console.error("[gemi] Resolving the session of a socket upgrade failed.", error);
      return refuse(503, "The session could not be checked.", { "Retry-After": "5" });
    }
    const userId = userIdOf(user);
    if (userId && (this.perUser.get(userId) ?? 0) >= this.config.maxConnectionsPerUser) {
      return refuse(429, "Too many connections for this user.", { "Retry-After": "30" });
    }
    if (userId) {
      reservation.userId = userId;
      this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
    }

    const socketId = newSocketId();
    const data: GemiSocketData = {
      gemiSocket: true,
      hub: this,
      socketId,
      tag: socketTag(socketId),
      request: { url: req.url, headers: [...req.headers] },
      carried,
      userId,
      ip: reservation.ip,
      subs: new Map(),
      topics: new Map(),
      rate: { windowStart: Date.now(), subs: 0, pings: 0 },
      reservation,
      closing: false,
      closed: false,
    };
    const upgraded = server.upgrade(req, {
      headers: { "Sec-WebSocket-Protocol": BROADCAST_PROTOCOL },
      data,
    });
    if (!upgraded) return refuse(400, "The WebSocket upgrade failed.");
    return undefined;
  }

  /**
   * `true`, or why the upgrade is refused. A browser always sends `Origin` on
   * a WebSocket upgrade, and cookies ride along with it whatever the page
   * that opened it, so an upgrade carrying cookies must come from an allowed
   * origin and one without `Origin` is refused. A native client sends its
   * token in a header and no cookies, and may leave `Origin` out.
   */
  private checkOrigin(req: Request): true | string {
    const origin = req.headers.get("origin");
    const hasCookies = Boolean(req.headers.get("cookie"));
    if (!origin) {
      return hasCookies ? "A socket that carries cookies must send an Origin header." : true;
    }
    return this.originAllowed(origin, req) ? true : "This origin may not open a socket.";
  }

  /** Whether `origin` may open a socket. */
  originAllowed(origin: string, req: Request): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // The request's own host: the page and the socket share an origin.
    const host = req.headers.get("host");
    if (host && url.host.toLowerCase() === host.toLowerCase()) return true;
    // Subdomains are never implied, `route.domains` ones included: those
    // serve tenant content, are same-site with the app (so its cookies ride
    // along), and a WebSocket has no CORS. A wildcard entry opts in.
    for (const allowed of [
      process.env.APP_URL,
      process.env.HOST_NAME,
      ...this.config.allowedOrigins,
    ]) {
      if (allowed && originMatches(allowed.trim(), url)) return true;
    }
    return false;
  }

  private reserve(ip: string | null): Reservation {
    this.connections++;
    if (ip) this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    return { ip, userId: null };
  }

  private release(reservation: Reservation) {
    this.connections--;
    decrement(this.perIp, reservation.ip);
    decrement(this.perUser, reservation.userId);
  }

  /** `Bun.serve`'s `websocket` option. */
  get websocket(): WebSocketHandler<GemiSocketData> {
    return {
      open: (ws) => ws.data.hub.onOpen(ws),
      message: (ws, message) => ws.data.hub.onMessage(ws, message),
      close: (ws) => ws.data.hub.onClose(ws),
      ...this.socketOptions(),
    };
  }

  /** The server-wide socket settings, also for a handler shared with HMR in dev. */
  socketOptions() {
    return {
      maxPayloadLength: this.config.maxInboundMessageBytes,
      idleTimeout: this.config.idleTimeout,
      // The hub closes a socket over `backpressureLimit` with 1013 at its
      // next delivery; Bun's own limit, at twice that, is the backstop for a
      // burst between two deliveries (Bun closes with 1006).
      backpressureLimit: this.config.backpressureLimit * 2,
      closeOnBackpressureLimit: true,
      sendPings: true,
      perMessageDeflate: false,
    } as const;
  }

  onOpen(ws: GemiSocket) {
    const data = ws.data;
    if (this.closing) {
      this.sayBye(ws);
      return;
    }
    this.sockets.add(ws);
    send(ws, {
      op: "hello",
      socketId: data.socketId,
      tag: data.tag,
      heartbeatMs: this.config.heartbeatMs,
    });
  }

  onMessage(ws: GemiSocket, message: string | Buffer) {
    if (typeof message !== "string") {
      ws.close(CloseCode.UnsupportedData, "Frames are JSON text.");
      return;
    }
    if (message.length > this.config.maxInboundMessageBytes) {
      ws.close(CloseCode.PolicyViolation, "Frame too large.");
      return;
    }
    let frame: any;
    try {
      frame = JSON.parse(message);
    } catch {
      ws.close(CloseCode.UnsupportedData, "Frames are JSON text.");
      return;
    }
    switch (frame?.op) {
      case "ping":
        if (this.countPing(ws)) send(ws, { op: "pong" });
        return;
      case "sub":
        this.subscribe(ws, frame).catch((error) => {
          console.error("[gemi] A socket subscription failed.", error);
          if (typeof frame.id === "string" && ws.data.subs.has(frame.id)) {
            const sub = ws.data.subs.get(frame.id)!;
            ws.data.subs.delete(frame.id);
            if (sub.topic && !ws.data.closed) this.leave(ws, sub.topic);
            if (!ws.data.closed) deny(ws, frame.id, "error");
          }
        });
        return;
      case "unsub":
        this.unsubscribeFrame(ws, frame);
        return;
      default:
        ws.close(CloseCode.UnsupportedData, "Unknown op.");
    }
  }

  onClose(ws: GemiSocket) {
    const data = ws.data;
    if (data.closed) return;
    data.closed = true;
    for (const [, sub] of data.subs) {
      if (sub.topic) this.leave(ws, sub.topic);
    }
    data.subs.clear();
    this.sockets.delete(ws);
    if (data.reservation) {
      this.release(data.reservation);
      data.reservation = null;
    }
  }

  private rateWindow(ws: GemiSocket) {
    const rate = ws.data.rate;
    const now = Date.now();
    if (now - rate.windowStart >= this.config.subscribeRate.windowMs) {
      rate.windowStart = now;
      rate.subs = 0;
      rate.pings = 0;
    }
    return rate;
  }

  /**
   * Counts a `sub`. Only `sub` frames count: an `unsub` costs the server
   * nothing to speak of, and counting it would charge a component's every
   * mount and unmount twice.
   */
  private countSub(ws: GemiSocket): "ok" | "limited" | "closed" {
    const { limit } = this.config.subscribeRate;
    const rate = this.rateWindow(ws);
    rate.subs++;
    if (rate.subs > limit * 2) {
      console.warn(`[gemi] Socket closed for sending too many subscribe frames (1008).`);
      ws.close(CloseCode.PolicyViolation, "Too many subscribe frames.");
      return "closed";
    }
    return rate.subs > limit ? "limited" : "ok";
  }

  /** `false` when the socket was closed for pinging too often. */
  private countPing(ws: GemiSocket): boolean {
    const rate = this.rateWindow(ws);
    rate.pings++;
    if (rate.pings <= PING_LIMIT_PER_WINDOW) return true;
    ws.close(CloseCode.PolicyViolation, "Too many pings.");
    return false;
  }

  private async subscribe(ws: GemiSocket, frame: Record<string, unknown>) {
    const data = ws.data;
    const id = frame.id;
    if (typeof id !== "string" || !SUBSCRIPTION_ID.test(id)) {
      ws.close(CloseCode.UnsupportedData, "A sub needs an id.");
      return;
    }
    const rate = this.countSub(ws);
    if (rate === "closed") return;
    if (rate === "limited") return deny(ws, id, "rate_limited");
    const pattern = frame.ch;
    const params = frame.p ?? {};
    if (typeof pattern !== "string" || !isParams(params)) return deny(ws, id, "invalid");
    if (data.subs.has(id)) return deny(ws, id, "invalid");
    if (data.subs.size >= this.config.maxChannelsPerSocket) return deny(ws, id, "limit");

    const sub: Subscription = { pattern, params, topic: null };
    data.subs.set(id, sub);
    if (!this.manager.channels) {
      data.subs.delete(id);
      return deny(ws, id, "unknown_channel");
    }

    // A revocation of the topic committed while the authorization ran may
    // not have been seen by it: authorize again until none has.
    let result: AuthorizeResult;
    for (let attempt = 1; ; attempt++) {
      const seq = this.revocationSeq;
      result = await this.authorize(ws, sub);
      // Unsubscribed, or the socket closed, while it was being authorized.
      if (data.closed || data.subs.get(id) !== sub) return;
      if (result.ok !== true) break;
      if ((this.revokedAt.get(result.topic) ?? 0) <= seq) break;
      if (attempt >= MAX_AUTHORIZE_ATTEMPTS) {
        data.subs.delete(id);
        return deny(ws, id, "error");
      }
    }
    if (result.ok !== true) {
      data.subs.delete(id);
      return deny(ws, id, (result as { code: DeniedCode }).code);
    }

    sub.topic = result.topic;
    try {
      await this.join(ws, result.topic);
    } catch (error) {
      console.error(
        `[gemi] The broadcast driver could not subscribe to "${result.topic}".`,
        error,
      );
      if (data.subs.get(id) === sub) {
        data.subs.delete(id);
        if (!data.closed) this.leave(ws, result.topic);
        deny(ws, id, "error");
      }
      return;
    }
    if (data.closed || data.subs.get(id) !== sub) return;
    // Only now: the driver delivers this topic to this process, so the
    // resync the client runs on this ack cannot miss an event.
    send(ws, { op: "subscribed", id, t: result.topic });
  }

  /** Runs the channel's authorization for `sub`, as the socket's upgrade request. */
  private authorize(ws: GemiSocket, sub: Subscription): Promise<AuthorizeResult> {
    const data = ws.data;
    const channels = this.manager.channels;
    if (!channels) return Promise.resolve({ ok: false, code: "unknown_channel" });
    return this.run(() =>
      channels.authorize(
        new Request(data.request.url, { headers: data.request.headers }),
        sub.pattern,
        sub.params,
        { carried: data.carried },
      ),
    ) as Promise<AuthorizeResult>;
  }

  private unsubscribeFrame(ws: GemiSocket, frame: Record<string, unknown>) {
    const id = frame.id;
    if (typeof id !== "string" || !SUBSCRIPTION_ID.test(id)) {
      ws.close(CloseCode.UnsupportedData, "An unsub needs an id.");
      return;
    }
    const sub = ws.data.subs.get(id);
    if (!sub) return;
    ws.data.subs.delete(id);
    if (sub.topic) this.leave(ws, sub.topic);
  }

  /** Puts `ws` on `topic`, and resolves once the driver delivers the topic here. */
  private join(ws: GemiSocket, topic: string): Promise<void> {
    const data = ws.data;
    const count = data.topics.get(topic) ?? 0;
    data.topics.set(topic, count + 1);
    if (count === 0) {
      ws.subscribe(topic);
      let set = this.byTopic.get(topic);
      if (!set) {
        set = new Set();
        this.byTopic.set(topic, set);
        const ready = Promise.resolve().then(() => this.manager.topicAdded(topic));
        this.topicReady.set(topic, ready);
        // A failed `topicAdded` is not cached: the next join tries again.
        ready.catch(() => {
          if (this.topicReady.get(topic) === ready) this.topicReady.delete(topic);
        });
      }
      set.add(ws);
    }
    return this.topicReady.get(topic) ?? Promise.resolve();
  }

  private leave(ws: GemiSocket, topic: string) {
    const data = ws.data;
    const count = data.topics.get(topic) ?? 0;
    if (count > 1) {
      data.topics.set(topic, count - 1);
      return;
    }
    data.topics.delete(topic);
    if (!data.closed) ws.unsubscribe(topic);
    const set = this.byTopic.get(topic);
    if (!set) return;
    set.delete(ws);
    if (set.size > 0) return;
    this.byTopic.delete(topic);
    this.topicReady.delete(topic);
    Promise.resolve()
      .then(() => this.manager.topicRemoved(topic))
      .catch((error) =>
        console.error(`[gemi] The broadcast driver could not unsubscribe from "${topic}".`, error),
      );
  }

  /**
   * The driver's delivery for this process. A socket already over the
   * backpressure limit is closed first (1013): it would only fall further
   * behind, and its client recovers by reconnecting and refetching.
   */
  deliver(topic: string, frame: string) {
    const set = this.byTopic.get(topic);
    if (!set || !this.server) return;
    const limit = this.config.backpressureLimit;
    for (const ws of set) {
      if (!ws.data.closing && ws.getBufferedAmount() > limit) {
        console.warn(`[gemi] Socket closed for backpressure (1013) on "${topic}".`);
        closeSocket(ws, CloseCode.TryAgainLater, "Too far behind; reconnect.");
      }
    }
    this.server.publish(topic, frame);
  }

  /** Applies a revocation that reached this process. */
  applyRevocation(revocation: BroadcastRevocation) {
    if ("user" in revocation) {
      for (const ws of this.sockets) {
        if (ws.data.userId === revocation.user && !ws.data.closing) {
          closeSocket(ws, CloseCode.Revoked, "Revoked.");
        }
      }
      return;
    }
    const topic = revocation.topic;
    const seq = ++this.revocationSeq;
    this.revokedAt.set(topic, seq);
    const set = this.byTopic.get(topic);
    if (!set) return;
    for (const ws of set) void this.reauthorize(ws, topic, seq);
  }

  /**
   * After `revoke({ channel })`: every subscription `ws` has on `topic` is
   * authorized again, as the socket's upgrade request. The ones refused are
   * denied with `revoked`; the others stay, and get a fresh `subscribed` so
   * the client resyncs whatever was published while the topic was paused.
   * The socket receives nothing on the topic until the answers are in.
   */
  private async reauthorize(ws: GemiSocket, topic: string, seq: number) {
    const data = ws.data;
    const subs = [...data.subs].filter(([, sub]) => sub.topic === topic);
    if (subs.length === 0) return;
    ws.unsubscribe(topic);
    const results = await Promise.all(
      subs.map(([, sub]) =>
        this.authorize(ws, sub).catch((error) => {
          console.error(`[gemi] Authorizing "${topic}" again after a revoke failed.`, error);
          return { ok: false, code: "revoked" } as AuthorizeResult;
        }),
      ),
    );
    if (data.closed) return;
    // A later revocation of the topic runs its own pass, and decides.
    if (this.revokedAt.get(topic) !== seq) return;
    subs.forEach(([id, sub], index) => {
      const result = results[index];
      if (data.subs.get(id) !== sub) return;
      if (result.ok === true && result.topic === topic) return;
      data.subs.delete(id);
      this.leave(ws, topic);
      deny(ws, id, "revoked");
    });
    if (!data.topics.has(topic)) return;
    ws.subscribe(topic);
    for (const [id, sub] of data.subs) {
      if (sub.topic === topic) send(ws, { op: "subscribed", id, t: topic });
    }
  }

  private sendAll(frame: ServerFrame) {
    const text = JSON.stringify(frame);
    for (const ws of this.sockets) ws.send(text);
  }

  /**
   * Stops accepting sockets and says `bye` to every open one, with a
   * jittered `retryAfter` (1–5 s) so a restart's reconnects do not arrive at
   * once, then closes them (1012). Sockets that have not closed after
   * `terminateAfterMs` are cut. Idempotent.
   */
  shutdown(options: { terminateAfterMs?: number } = {}) {
    if (this.closing) return;
    this.closing = true;
    const sockets = [...this.sockets];
    if (sockets.length > 0) {
      console.log(`[gemi] Closing ${sockets.length} broadcast socket(s) (1012).`);
    }
    for (const ws of sockets) this.sayBye(ws);
    // Every one of them, closed or not: a socket whose close frame was
    // answered can still hold the connection open, and a graceful
    // `server.stop()` waits on it.
    const timer = setTimeout(() => {
      for (const ws of sockets) {
        try {
          ws.terminate();
        } catch {
          // Already gone.
        }
      }
    }, options.terminateAfterMs ?? 2_000);
    (timer as { unref?: () => void }).unref?.();
  }

  /** Whether `shutdown` ran. */
  get isClosing(): boolean {
    return this.closing;
  }

  private sayBye(ws: GemiSocket) {
    send(ws, {
      op: "bye",
      code: CloseCode.Restart,
      retryAfter: 1_000 + Math.floor(Math.random() * 4_000),
    });
    closeSocket(ws, CloseCode.Restart, "Server restarting.");
  }

  /** In the application's scope, as a request is: facades resolve from it. */
  private run<T>(fn: () => T): T {
    return kernelContext.run(this.application, fn);
  }
}

type AuthorizeResult = { ok: true; topic: string } | { ok: false; code: DeniedCode };

/**
 * Whether an `allowedOrigins` entry (or `APP_URL` / `HOST_NAME`) admits
 * `url`. An entry is an origin (`https://app.example.com`), a bare host
 * (`app.example.com`), or a wildcard for the subdomains of a host
 * (`*.example.com`, `https://*.example.com`), which does not admit the host
 * itself.
 */
export function originMatches(allowed: string, url: URL): boolean {
  const wildcard = /^(?:(https?):\/\/)?\*\.([^/:]+)(?::(\d+))?\/?$/i.exec(allowed);
  if (wildcard) {
    const [, scheme, base, port] = wildcard;
    if (scheme && `${scheme.toLowerCase()}:` !== url.protocol) return false;
    if ((port ?? "") !== url.port) return false;
    return url.hostname.toLowerCase().endsWith(`.${base.toLowerCase().replace(/\.$/, "")}`);
  }
  if (/^https?:\/\//i.test(allowed)) {
    try {
      return new URL(allowed).origin === url.origin;
    } catch {
      return false;
    }
  }
  // A bare host.
  return allowed.toLowerCase().replace(/\/$/, "") === url.host.toLowerCase();
}

function closeSocket(ws: GemiSocket, code: number, reason: string) {
  ws.data.closing = true;
  ws.close(code, reason);
}

function send(ws: GemiSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame));
}

function deny(ws: GemiSocket, id: string, code: DeniedCode) {
  send(ws, { op: "denied", id, code });
}

function refuse(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

function isParams(value: unknown): value is Record<string, string | number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string" || typeof v === "number");
}

function userIdOf(user: unknown): string | null {
  const id = (user as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

/**
 * The client address: what the production server left in `X-Forwarded-For`
 * (see `forwardedFor.ts`), or the socket's peer.
 */
function clientIp(req: Request, server: Server<any>): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return server.requestIP(req)?.address ?? null;
  } catch {
    return null;
  }
}

function decrement(map: Map<string, number>, key: string | null) {
  if (!key) return;
  const count = (map.get(key) ?? 0) - 1;
  if (count <= 0) map.delete(key);
  else map.set(key, count);
}
