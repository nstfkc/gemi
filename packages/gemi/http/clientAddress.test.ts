import { describe, expect, test } from "vitest";

import { HttpRequest } from "./HttpRequest";
import { addressBlock } from "./clientAddress";
import { clientAddress, clientIp } from "./RateLimitMiddleware";

describe("addressBlock", () => {
  test("keeps an IPv4 address as it is", () => {
    expect(addressBlock("203.0.113.7")).toBe("203.0.113.7");
    expect(addressBlock("203.0.113.7:51234")).toBe("203.0.113.7");
  });

  test("cuts an IPv6 address to its /64", () => {
    expect(addressBlock("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressBlock("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressBlock("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:2::/64");
    expect(addressBlock("2001:db8::1")).toBe("2001:db8::/64");
    expect(addressBlock("::1")).toBe("::/64");
    expect(addressBlock("fe80::1%eth0")).toBe("fe80::/64");
  });

  test("every address inside one /64 gives the same block, and the next /64 another", () => {
    const block = addressBlock("2001:db8:aa:bb::1");
    for (const address of ["2001:db8:aa:bb:ffff:ffff:ffff:ffff", "2001:db8:aa:bb:1234::", "2001:db8:aa:bb::2"]) {
      expect(addressBlock(address)).toBe(block);
    }
    expect(addressBlock("2001:db8:aa:bc::1")).not.toBe(block);
  });

  test("gives an IPv4-mapped address as its IPv4 address", () => {
    expect(addressBlock("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressBlock("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(addressBlock("[::ffff:203.0.113.7]:80")).toBe("203.0.113.7");
  });

  test("takes another prefix length", () => {
    expect(addressBlock("2001:db8:1:2:3:4:5:6", { ipv6Prefix: 48 })).toBe("2001:db8:1::/48");
    expect(addressBlock("2001:db8:1:2:3:4:5:6", { ipv6Prefix: 56 })).toBe("2001:db8:1::/56");
    expect(addressBlock("2001:db8:1:2ff:3:4:5:6", { ipv6Prefix: 56 })).toBe("2001:db8:1:200::/56");
    expect(addressBlock("2001:DB8::0:1", { ipv6Prefix: 128 })).toBe("2001:db8::1");
    expect(addressBlock("2001:db8::1", { ipv6Prefix: 0 })).toBe("::/0");
  });

  test("answers what is not an address unchanged", () => {
    expect(addressBlock("unknown")).toBe("unknown");
    expect(addressBlock("")).toBe("");
    expect(addressBlock("2001:db8::g")).toBe("2001:db8::g");
  });

  test("refuses a prefix length that is not one", () => {
    for (const ipv6Prefix of [-1, 129, 64.5, Number.NaN]) {
      expect(() => addressBlock("2001:db8::1", { ipv6Prefix })).toThrow(RangeError);
    }
  });
});

describe("clientAddress", () => {
  const request = (forwardedFor: string) =>
    new HttpRequest(new Request("http://localhost/", { headers: { "x-forwarded-for": forwardedFor } }));

  test("is clientIp's address, grouped by /64", () => {
    const req = request("2001:db8:1:2:3:4:5:6, 10.0.0.1");
    expect(clientIp(req)).toBe("2001:db8:1:2:3:4:5:6");
    expect(clientAddress(req)).toBe("2001:db8:1:2::/64");
    expect(clientAddress(req, { ipv6Prefix: 48 })).toBe("2001:db8:1::/48");
    expect(clientAddress(request("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientAddress(new HttpRequest(new Request("http://localhost/")))).toBe("unknown");
  });
});
