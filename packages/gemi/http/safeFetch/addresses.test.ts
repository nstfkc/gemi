import { describe, expect, test } from "vitest";

import {
  classifyAddress,
  formatAddress,
  parseAddress,
  parseCidr,
  parseIPv4,
  parseIPv6,
} from "./addresses";

describe("parseIPv4", () => {
  test.each([
    ["127.0.0.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["10.1", "10.0.0.1"],
    ["0", "0.0.0.0"],
    ["0xA9.0xFE.0xA9.0xFE", "169.254.169.254"],
    ["169.254.43518", "169.254.169.254"],
    ["127.0.0.1.", "127.0.0.1"],
  ])("%s is %s", (input, expected) => {
    const bytes = parseIPv4(input);
    expect(bytes && formatAddress({ family: 4, bytes })).toBe(expected);
  });

  test.each([
    "",
    "256.0.0.1",
    "1.2.3.4.5",
    "08.0.0.1",
    "0xg.1",
    "example.com",
    "4294967296",
    "1..2",
  ])("%j is not an address", (input) => {
    expect(parseIPv4(input)).toBeNull();
  });
});

describe("parseIPv6", () => {
  test.each([
    ["::1", "0:0:0:0:0:0:0:1"],
    ["[::1]", "0:0:0:0:0:0:0:1"],
    ["::", "0:0:0:0:0:0:0:0"],
    ["::ffff:10.0.0.1", "0:0:0:0:0:ffff:a00:1"],
    ["fe80::1%en0", "fe80:0:0:0:0:0:0:1"],
    ["2001:db8::8a2e:370:7334", "2001:db8:0:0:0:8a2e:370:7334"],
  ])("%s parses", (input, expected) => {
    const bytes = parseIPv6(input);
    expect(bytes && formatAddress({ family: 6, bytes })).toBe(expected);
  });

  test.each([
    "1::2::3",
    "12345::",
    "1.2.3.4::",
    "1:2:3:4:5:6:7:8:9",
    "::g",
    "127.0.0.1",
  ])("%j is not an address", (input) => {
    expect(parseIPv6(input)).toBeNull();
  });
});

describe("classifyAddress", () => {
  test.each([
    // IPv4, every non-public range.
    ["0.0.0.0", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "shared"],
    ["100.100.100.200", "shared"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "metadata"],
    ["169.254.0.5", "link-local"],
    ["168.63.129.16", "metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.192", "reserved"],
    ["192.0.2.1", "documentation"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    // Odd IPv4 notations are the same addresses.
    ["2130706433", "loopback"],
    ["0x7f.1", "loopback"],
    ["0177.0.0.1", "loopback"],
    ["0xA9FEA9FE", "metadata"],
    // IPv6.
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::127.0.0.1", "reserved"],
    ["fe80::1", "link-local"],
    ["fe80::1%lo0", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fd00:ec2::254", "metadata"],
    ["fec0::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"],
    ["100::1", "reserved"],
    ["64:ff9b:1::1", "private"],
    ["4000::1", "reserved"],
    // IPv6 carrying an IPv4 address is judged by the IPv4 address.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "metadata"],
    ["0:0:0:0:0:ffff:a9fe:a9fe", "metadata"],
    ["64:ff9b::10.0.0.1", "private"],
    ["64:ff9b::7f00:1", "loopback"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:c0a8:101::1", "private"],
    // Not an address at all.
    ["example.com", "reserved"],
  ])("%s is %s", (input, kind) => {
    expect(classifyAddress(input)?.kind).toBe(kind);
  });

  test.each([
    "93.184.215.14",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "169.255.0.1",
    "192.169.0.1",
    "2606:4700:10::6814:179a",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:808:808::1",
  ])("%s is public", (input) => {
    expect(classifyAddress(input)).toBeNull();
  });
});

describe("parseCidr", () => {
  test("ranges and bare addresses", () => {
    expect(parseCidr("10.0.0.0/8")).toMatchObject({ family: 4, prefix: 8 });
    expect(parseCidr("10.1.2.3")).toMatchObject({ family: 4, prefix: 32 });
    expect(parseCidr("fc00::/7")).toMatchObject({ family: 6, prefix: 7 });
    expect(parseCidr("::ffff:10.0.0.0/104")).toMatchObject({
      family: 4,
      prefix: 8,
    });
  });

  test.each(["10.0.0.0/33", "10.0.0/8", "0x7f.1", "fc00::/129", "example.com"])(
    "%j is refused",
    (input) => {
      expect(parseCidr(input)).toBeNull();
    },
  );

  test("parseAddress reads both families", () => {
    expect(parseAddress("::1")?.family).toBe(6);
    expect(parseAddress("1.2.3.4")?.family).toBe(4);
    expect(parseAddress("nope")).toBeNull();
  });
});
