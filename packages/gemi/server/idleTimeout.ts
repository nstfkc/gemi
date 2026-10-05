/**
 * Bun's default, and what both servers use when `SERVER_IDLE_TIMEOUT` is unset.
 */
export const DEFAULT_SERVER_IDLE_TIMEOUT = 10;

/**
 * The `idleTimeout` (seconds) both `gemi dev` and `gemi start` pass to
 * `Bun.serve`, from `SERVER_IDLE_TIMEOUT` (#787).
 *
 * One reader for both servers, so a long-poll that works under `gemi start`
 * also works under `gemi dev`. Before this, only `httpProd` read the variable
 * and the dev server always ran at Bun's 10 seconds.
 *
 * It is the time a connection may stay silent, a response that has not started
 * included, before Bun closes it; `0` disables it. It does not apply to an
 * upgraded websocket (the HMR relay included), which has its own
 * `websocket.idleTimeout`.
 *
 * Unset or blank means the default. Anything that is not a whole number from 0
 * to 255 (Bun's own limits) fails the boot with the variable's name, instead
 * of Bun's "expects idleTimeout to be an integer", which does not say where the
 * value came from.
 */
export function serverIdleTimeout(raw: string | undefined = process.env.SERVER_IDLE_TIMEOUT): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SERVER_IDLE_TIMEOUT;

  const seconds = Number(raw.trim());
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 255) {
    throw new Error(
      `SERVER_IDLE_TIMEOUT must be a whole number of seconds from 0 to 255 ` +
        `(0 disables the timeout), got ${JSON.stringify(raw)}.`,
    );
  }
  return seconds;
}
