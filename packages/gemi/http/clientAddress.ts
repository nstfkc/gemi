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

/**
 * The block an address belongs to, for keying limits: an IPv4 address as it
 * is; an IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) as its IPv4 address;
 * any other IPv6 address as its first `ipv6Prefix` bits (`2001:db8:1:2::/64`).
 *
 * One host is usually handed a whole /64, and it can pick any address in it,
 * so a limit keyed on the full IPv6 address is one it resets by changing
 * address. Anything that is not an address (`unknown`, a header `gemi dev`
 * passes through as sent) is answered unchanged.
 */
export function addressBlock(address: string, { ipv6Prefix = 64 }: { ipv6Prefix?: number } = {}): string {
  if (!Number.isInteger(ipv6Prefix) || ipv6Prefix < 0 || ipv6Prefix > 128) {
    throw new RangeError(`ipv6Prefix must be a whole number from 0 to 128, not ${ipv6Prefix}.`);
  }
  const ip = normalizeIpEntry(address);
  if (ip === null || isIP(ip) === 4) {
    return ip ?? address;
  }
  const groups = ipv6Groups(ip);
  if (groups === null) {
    return address;
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  const masked = groups.map((group, index) => {
    const bits = Math.min(Math.max(ipv6Prefix - index * 16, 0), 16);
    return group & ((0xffff << (16 - bits)) & 0xffff);
  });
  const block = formatIpv6(masked);
  return ipv6Prefix === 128 ? block : `${block}/${ipv6Prefix}`;
}

/** The eight 16-bit groups of an IPv6 address `isIP` accepted, zone dropped. */
function ipv6Groups(address: string): number[] | null {
  let value = address.split("%")[0]!.toLowerCase();
  // An embedded IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    value = `${value.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = value.split("::") as [string, string | undefined];
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  const groups =
    tail === undefined ? front : [...front, ...Array.from({ length: 8 - front.length - back.length }, () => 0), ...back];
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

/** RFC 5952 text: lower-case, no leading zeros, the longest run of 2+ zero groups as `::`. */
function formatIpv6(groups: number[]): string {
  let start = -1;
  let length = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > length) {
      start = i;
      length = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (length < 2) {
    return hex.join(":");
  }
  return `${hex.slice(0, start).join(":")}::${hex.slice(start + length).join(":")}`;
}
