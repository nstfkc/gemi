/**
 * IP addresses as bytes, and which of them are not on the public internet.
 *
 * Everything here works on parsed bytes, never on strings: an address is
 * classified the same way however it was written (`127.0.0.1`, `2130706433`,
 * `0x7f.1`, `0177.0.0.1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`).
 */

export type ParsedAddress =
  | { family: 4; bytes: Uint8Array }
  | { family: 6; bytes: Uint8Array };

/**
 * Why an address is refused. `null` from `classifyAddress` means the address
 * is publicly routable.
 */
export type AddressRange =
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "shared"
  | "metadata"
  | "multicast"
  | "broadcast"
  | "documentation"
  | "benchmarking"
  | "unique-local"
  | "reserved";

/**
 * Parses an IPv4 address the way a URL host parser (and `inet_aton`) does: one
 * to four parts, each decimal, octal (leading `0`) or hex (`0x`), the last part
 * filling the remaining bytes. `"2130706433"`, `"0x7f.1"` and `"0177.0.0.1"`
 * all parse to 127.0.0.1. Returns `null` for anything that is not an address.
 */
export function parseIPv4(input: string): Uint8Array | null {
  if (input === "") return null;
  const parts = input.split(".");
  // One trailing dot is allowed ("127.0.0.1."), as in a URL host.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseIPv4Part(part);
    if (value === null) return null;
    numbers.push(value);
  }
  const last = numbers.pop()!;
  for (const value of numbers) if (value > 255) return null;
  if (last >= 256 ** (4 - numbers.length)) return null;
  let total = last;
  numbers.forEach((value, index) => {
    total += value * 256 ** (3 - index);
  });
  return new Uint8Array([
    Math.floor(total / 2 ** 24) & 255,
    Math.floor(total / 2 ** 16) & 255,
    Math.floor(total / 2 ** 8) & 255,
    total & 255,
  ]);
}

function parseIPv4Part(part: string): number | null {
  if (part === "") return null;
  let digits = part;
  let radix = 10;
  if (/^0x/i.test(digits)) {
    digits = digits.slice(2);
    radix = 16;
    if (digits === "") return 0;
  } else if (digits.length > 1 && digits.startsWith("0")) {
    digits = digits.slice(1);
    radix = 8;
  }
  const pattern =
    radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  const value = parseInt(digits, radix);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parses an IPv6 address, with or without brackets and a zone (`fe80::1%en0`),
 * including a dotted IPv4 tail (`::ffff:10.0.0.1`).
 */
export function parseIPv6(input: string): Uint8Array | null {
  let text = input;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (half: string, lastHalf: boolean): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    const pieces = half.split(":");
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index];
      if (lastHalf && index === pieces.length - 1 && piece.includes(".")) {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(piece)) return null;
        const v4 = piece.split(".").map(Number);
        if (v4.some((byte) => byte > 255)) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0], halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(halves[1], true) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 255;
  });
  return bytes;
}

/** Parses an IPv4 (in any notation) or IPv6 address. */
export function parseAddress(input: string): ParsedAddress | null {
  const v6 = parseIPv6(input);
  if (v6) return { family: 6, bytes: v6 };
  const v4 = parseIPv4(input);
  if (v4) return { family: 4, bytes: v4 };
  return null;
}

/**
 * The IPv4 address an IPv6 address stands for when it is IPv4-mapped
 * (`::ffff:a.b.c.d`), so the two forms are one address everywhere.
 */
export function unmap(address: ParsedAddress): ParsedAddress {
  if (address.family === 6 && isMapped(address.bytes)) {
    return { family: 4, bytes: address.bytes.slice(12) };
  }
  return address;
}

function isMapped(bytes: Uint8Array) {
  for (let index = 0; index < 10; index++) if (bytes[index] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

export function formatAddress(address: ParsedAddress): string {
  if (address.family === 4) return Array.from(address.bytes).join(".");
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(
      ((address.bytes[index] << 8) | address.bytes[index + 1]).toString(16),
    );
  }
  return groups.join(":");
}

export type Cidr = { family: 4 | 6; bytes: Uint8Array; prefix: number };

/** Parses `10.0.0.0/8`, `fc00::/7`, or a bare address (a /32 or /128). */
export function parseCidr(input: string): Cidr | null {
  const slash = input.lastIndexOf("/");
  const addressText = slash === -1 ? input : input.slice(0, slash);
  // CIDRs are configuration, written by hand: only the plain notations.
  const address = /^[0-9.]+$/.test(addressText)
    ? strictIPv4(addressText)
    : parseIPv6(addressText);
  if (!address) return null;
  const parsed = unmap(
    address.length === 4
      ? { family: 4, bytes: address }
      : { family: 6, bytes: address },
  );
  const max = parsed.family === 4 ? 32 : 128;
  let prefix = max;
  if (slash !== -1) {
    const prefixText = input.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    // A mapped CIDR (`::ffff:10.0.0.0/104`) is narrowed to its IPv4 prefix.
    if (address.length === 16 && parsed.family === 4) prefix -= 96;
    if (prefix < 0 || prefix > max) return null;
  }
  return { family: parsed.family, bytes: parsed.bytes, prefix };
}

function strictIPv4(text: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) &&
    text.split(".").every((part) => Number(part) <= 255)
    ? new Uint8Array(text.split(".").map(Number))
    : null;
}

export function inCidr(address: ParsedAddress, cidr: Cidr): boolean {
  const plain = unmap(address);
  if (plain.family !== cidr.family) return false;
  let remaining = cidr.prefix;
  for (let index = 0; remaining > 0; index++) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((plain.bytes[index] & mask) !== (cidr.bytes[index] & mask))
      return false;
    remaining -= bits;
  }
  return true;
}

const range = (cidr: string, kind: AddressRange) => ({
  cidr: parseCidr(cidr)!,
  kind,
  text: cidr,
});

// IANA's IPv4 special-purpose registry, the entries that are not globally
// reachable, plus the cloud metadata endpoints that are not in it. Order
// matters only for the label: the first match names the reason.
const IPV4_RANGES = [
  range("0.0.0.0/8", "unspecified"),
  range("10.0.0.0/8", "private"),
  range("100.64.0.0/10", "shared"),
  range("127.0.0.0/8", "loopback"),
  range("169.254.169.254/32", "metadata"),
  range("169.254.0.0/16", "link-local"),
  range("168.63.129.16/32", "metadata"),
  range("172.16.0.0/12", "private"),
  range("192.0.0.0/24", "reserved"),
  range("192.0.2.0/24", "documentation"),
  range("192.88.99.0/24", "reserved"),
  range("192.168.0.0/16", "private"),
  range("198.18.0.0/15", "benchmarking"),
  range("198.51.100.0/24", "documentation"),
  range("203.0.113.0/24", "documentation"),
  range("224.0.0.0/4", "multicast"),
  range("255.255.255.255/32", "broadcast"),
  range("240.0.0.0/4", "reserved"),
];

const IPV6_RANGES = [
  range("::/128", "unspecified"),
  range("::1/128", "loopback"),
  range("64:ff9b:1::/48", "private"),
  // IPv4-compatible and the rest of the reserved ::/8.
  range("::/8", "reserved"),
  range("100::/64", "reserved"),
  range("2001:db8::/32", "documentation"),
  // IETF protocol assignments, Teredo (an IPv4 address hidden in the bits).
  range("2001::/23", "reserved"),
  range("3fff::/20", "documentation"),
  range("fd00:ec2::254/128", "metadata"),
  range("fc00::/7", "unique-local"),
  range("fe80::/10", "link-local"),
  range("fec0::/10", "private"),
  range("ff00::/8", "multicast"),
];

const NAT64 = parseCidr("64:ff9b::/96")!;
const SIX_TO_FOUR = parseCidr("2002::/16")!;
const GLOBAL_UNICAST = parseCidr("2000::/3")!;

export type Classification = { kind: AddressRange; range: string };

/**
 * Which non-public range an address is in, or `null` when it is publicly
 * routable. IPv6 forms that carry an IPv4 address (mapped, NAT64, 6to4) are
 * judged by the IPv4 address they carry.
 */
export function classifyAddress(
  input: string | ParsedAddress,
): Classification | null {
  const parsed = typeof input === "string" ? parseAddress(input) : input;
  if (!parsed) return { kind: "reserved", range: "not an IP address" };
  const address = unmap(parsed);
  if (address.family === 4) {
    const match = IPV4_RANGES.find((entry) => inCidr(address, entry.cidr));
    return match ? { kind: match.kind, range: match.text } : null;
  }
  if (inCidr(address, NAT64)) {
    return classifyAddress({ family: 4, bytes: address.bytes.slice(12) });
  }
  if (inCidr(address, SIX_TO_FOUR)) {
    return classifyAddress({ family: 4, bytes: address.bytes.slice(2, 6) });
  }
  const match = IPV6_RANGES.find((entry) => inCidr(address, entry.cidr));
  if (match) return { kind: match.kind, range: match.text };
  // Only 2000::/3 is allocated as global unicast; everything else is reserved.
  return inCidr(address, GLOBAL_UNICAST)
    ? null
    : { kind: "reserved", range: "outside 2000::/3" };
}

/** Two addresses are the same once mapped IPv6 is folded into IPv4. */
export function sameAddress(a: ParsedAddress, b: ParsedAddress) {
  const left = unmap(a);
  const right = unmap(b);
  return (
    left.family === right.family &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}
