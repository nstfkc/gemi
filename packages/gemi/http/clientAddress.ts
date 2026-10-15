import { isIP } from "node:net";

/**
 * One `X-Forwarded-For` (or client-IP header) entry as a bare address:
 * `203.0.113.7:51234` and `203.0.113.7` give `203.0.113.7`;
 * `[2001:db8::1]:443`, `[2001:db8::1]` and `2001:db8::1` give `2001:db8::1`.
 * `null` for anything that is not an IPv4/IPv6 address once its port is gone.
 */
export function normalizeIpEntry(entry: string): string | null {
  const value = entry.trim();
  if (value === "") {
    return null;
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) {
      return null;
    }
    const rest = value.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) {
      return null;
    }
    const address = value.slice(1, end);
    return isIP(address) === 6 ? address : null;
  }
  if (isIP(value)) {
    return value;
  }
  // Only IPv4 takes an unbracketed port: in `2001:db8::1:443` the last group
  // cannot be told apart from a port, and `isIP` already accepted it above.
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  return v4 && isIP(v4[1]!) === 4 ? v4[1]! : null;
}
