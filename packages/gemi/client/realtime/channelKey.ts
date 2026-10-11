import type { ChannelParamValues } from "./RealtimeClient";

// A module of its own so the socket client (`./RealtimeClient`, loaded on
// first use) and `FakeSocket` share it without reaching `./loader`, which
// would keep it in every route's entry chunk (#915).

/** `pattern` and its params, canonical: two hooks on one channel share a `sub`. */
export function channelKey(pattern: string, params: ChannelParamValues): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => [key, String(params[key])]);
  return `${pattern}\u0000${JSON.stringify(sorted)}`;
}
