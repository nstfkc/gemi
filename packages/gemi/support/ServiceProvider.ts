import type { Application } from "../foundation/Application";

/**
 * What a provider's `shutdown()` may resolve: nothing, or whether it
 * abandoned work at the deadline. See `ServiceProvider` below.
 */
export type ProviderShutdownResult = void | { abandoned: boolean };

/**
 * Every hook defaults to a no-op. `register()` binds services into the
 * container and must not resolve any of them; `boot()` runs after every
 * provider has registered, so it may resolve freely.
 *
 * `shutdown()` runs once when a production server is told to stop (`SIGTERM`
 * or `SIGINT`), after it has stopped accepting requests and the in-flight ones
 * have finished or run out of grace — so nothing a request needs is torn down
 * under it. Providers shut down in reverse registration order, so one
 * registered after another may still use it. Each is awaited, but under a
 * shared deadline (`GEMI_SHUTDOWN_PROVIDER_TIMEOUT`): one that overruns is
 * abandoned and the next begins, and one that throws is logged and does not
 * stop the rest. See `Application.shutdown`.
 *
 * Under `gemi dev` it also runs on every `bun --hot` reload, for the
 * application the reload replaced, once the new one is serving and the old
 * one's requests have finished (see `server/devReload.ts`). A hook that closes
 * something kept on `globalThis` across reloads would close it for the new
 * application too.
 *
 * `timeoutMs` is what is left of that shared deadline when this provider is
 * reached. A provider that waits for something — jobs finishing, a queue
 * draining — should bound its own wait by a little less than this, so that it
 * is still the one to report what it gave up on. Ignoring it is fine; the
 * provider is then simply abandoned at the deadline, with only a generic line
 * from `Application` to say so.
 *
 * A provider that bounds its own wait and gives up on work it was waiting for
 * resolves `{ abandoned: true }`. `Application` then reports it in `timedOut`
 * as if it had overrun, and the process exits `1` — the work was cut off just
 * the same, and an orchestrator or a log alert has to be able to see that from
 * the exit code. The provider names what it abandoned in its own log line.
 */
export abstract class ServiceProvider {
  constructor(protected app: Application) {}

  register(): void {}

  boot(): void | Promise<void> {}

  shutdown(options?: {
    timeoutMs: number;
  }): ProviderShutdownResult | Promise<ProviderShutdownResult> {}
}
