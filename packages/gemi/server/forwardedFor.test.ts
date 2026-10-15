import { describe, expect, test } from "vitest";

import { clientIp } from "../http/RateLimitMiddleware";
import { normalizeIpEntry } from "../http/clientAddress";
import {
  applyForwardedTrust,
  type ForwardedTrust,
  parseClientIpHeaderTrust,
  parseTrustProxy,
  trustedHeaderClientIp,
} from "./forwardedFor";

function apply(
  trust: ForwardedTrust,
  headers: Record<string, string>,
  peer: string | null = "10.0.0.2",
) {
  const h = new Headers(headers);
  applyForwardedTrust(h, peer, trust);
  return { forwardedFor: h.get("x-forwarded-for"), realIp: h.get("x-real-ip") };
}

describe("parseTrustProxy", () => {
  test.each([undefined, "", "false", "OFF", "0", " false "])(
    "%j trusts nothing",
    (value) => {
      expect(parseTrustProxy(value)).toEqual({ kind: "none" });
    },
  );

  test("true trusts every header as sent", () => {
    expect(parseTrustProxy("true")).toEqual({ kind: "all" });
    expect(parseTrustProxy("TRUE")).toEqual({ kind: "all" });
  });

  test("a positive integer is a hop count", () => {
    expect(parseTrustProxy("1")).toEqual({ kind: "hops", hops: 1 });
    expect(parseTrustProxy("2")).toEqual({ kind: "hops", hops: 2 });
  });

  test.each(["yes", "-1", "1.5", "10.0.0.0/8", "01"])(
    "%j fails the boot",
    (value) => {
      expect(() => parseTrustProxy(value)).toThrow(/GEMI_TRUST_PROXY/);
    },
  );
});

describe("applyForwardedTrust", () => {
  describe("trusting nothing (the default)", () => {
    const none = parseTrustProxy(undefined);

    test("a client-sent x-forwarded-for is replaced with the peer", () => {
      expect(apply(none, { "x-forwarded-for": "6.6.6.6" })).toEqual({
        forwardedFor: "10.0.0.2",
        realIp: null,
      });
    });

    test("a client-sent x-real-ip is dropped", () => {
      expect(apply(none, { "x-real-ip": "6.6.6.6" }).realIp).toBeNull();
    });

    test("with no peer address, nothing the client sent survives", () => {
      expect(
        apply(
          none,
          { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" },
          null,
        ),
      ).toEqual({
        forwardedFor: null,
        realIp: null,
      });
    });
  });

  describe("trusting n hops", () => {
    test("one proxy: the entry it appended is the client, a forged prefix is dropped", () => {
      const one = parseTrustProxy("1");
      expect(
        apply(one, { "x-forwarded-for": "6.6.6.6, 1.2.3.4" }).forwardedFor,
      ).toBe("1.2.3.4");
      expect(apply(one, { "x-forwarded-for": "1.2.3.4" }).forwardedFor).toBe(
        "1.2.3.4",
      );
    });

    test("two proxies: the address the outer one was reached from", () => {
      const two = parseTrustProxy("2");
      expect(
        apply(two, { "x-forwarded-for": "6.6.6.6, 1.2.3.4, 172.16.0.9" })
          .forwardedFor,
      ).toBe("1.2.3.4");
    });

    test("a chain shorter than the hop count falls back to its left-most hop", () => {
      const two = parseTrustProxy("2");
      expect(apply(two, { "x-forwarded-for": "1.2.3.4" }).forwardedFor).toBe(
        "1.2.3.4",
      );
      expect(apply(two, {}).forwardedFor).toBe("10.0.0.2");
    });

    test("ignores empty entries and drops x-real-ip", () => {
      const one = parseTrustProxy("1");
      expect(
        apply(one, {
          "x-forwarded-for": " , 1.2.3.4 ,",
          "x-real-ip": "6.6.6.6",
        }),
      ).toEqual({
        forwardedFor: "1.2.3.4",
        realIp: null,
      });
    });

    test("a unix socket peer still counts as the nearest hop", () => {
      const one = parseTrustProxy("1");
      expect(
        apply(one, { "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, null)
          .forwardedFor,
      ).toBe("1.2.3.4");
    });
  });

  describe("trusting everything (GEMI_TRUST_PROXY=true)", () => {
    const all = parseTrustProxy("true");

    test("passes the headers through as sent, as before", () => {
      expect(
        apply(all, {
          "x-forwarded-for": "6.6.6.6, 1.2.3.4",
          "x-real-ip": "7.7.7.7",
        }),
      ).toEqual({
        forwardedFor: "6.6.6.6, 1.2.3.4",
        realIp: "7.7.7.7",
      });
    });

    test("fills in the peer when there is none", () => {
      expect(apply(all, {}).forwardedFor).toBe("10.0.0.2");
    });
  });

  test("clientIp reads the address the policy left behind", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" });
    applyForwardedTrust(h, "10.0.0.2", parseTrustProxy("1"));
    const req = { headers: h, rawRequest: new Request("http://x/") } as any;
    expect(clientIp(req)).toBe("1.2.3.4");
  });
});

describe("ip:port entries (#958)", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["203.0.113.7:51234", "203.0.113.7"],
    [" 203.0.113.7:80 ", "203.0.113.7"],
    ["2001:db8::1", "2001:db8::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
  ])("normalizeIpEntry(%j) is %j", (entry, expected) => {
    expect(normalizeIpEntry(entry)).toBe(expected);
  });

  test.each(["", "unknown", "example.com", "203.0.113.7:", "203.0.113.7:abc", "999.1.1.1:80", "[203.0.113.7]", "[2001:db8::1", "[2001:db8::1]x"])(
    "normalizeIpEntry(%j) is not an address",
    (entry) => {
      expect(normalizeIpEntry(entry)).toBeNull();
    },
  );

  test("the hop chosen by GEMI_TRUST_PROXY loses its port", () => {
    const one = parseTrustProxy("1");
    expect(apply(one, { "x-forwarded-for": "198.51.100.1, 203.0.113.7:51234" }).forwardedFor).toBe(
      "203.0.113.7",
    );
    expect(apply(one, { "x-forwarded-for": "198.51.100.1, [2001:db8::1]:443" }).forwardedFor).toBe(
      "2001:db8::1",
    );
  });

  test("a chosen hop that is not an address falls back to the peer", () => {
    const one = parseTrustProxy("1");
    expect(apply(one, { "x-forwarded-for": "198.51.100.1, unknown" }).forwardedFor).toBe("10.0.0.2");
    const two = parseTrustProxy("2");
    expect(apply(two, { "x-forwarded-for": "junk" }).forwardedFor).toBe("10.0.0.2");
  });

  test("clientIp keys a passed-through ip:port without its port", () => {
    const req = (xff: string) =>
      ({ headers: new Headers({ "x-forwarded-for": xff }), rawRequest: new Request("http://x/") }) as any;
    expect(clientIp(req("203.0.113.7:51234, 10.0.0.1"))).toBe("203.0.113.7");
    expect(clientIp(req("[2001:db8::1]:443"))).toBe("2001:db8::1");
    expect(clientIp(req("not-an-ip"))).toBe("not-an-ip");
  });
});

describe("GEMI_CLIENT_IP_HEADER (#958)", () => {
  const FDID = "8a2b1c3d-0000-4e5f-9a8b-123456789abc";
  const env = {
    GEMI_CLIENT_IP_HEADER: "X-Azure-ClientIP",
    GEMI_PROXY_SECRET_HEADER: "X-Azure-FDID",
    GEMI_PROXY_SECRET: FDID,
  };

  test("unset is no policy", () => {
    expect(parseClientIpHeaderTrust({})).toBeNull();
    expect(parseClientIpHeaderTrust({ GEMI_CLIENT_IP_HEADER: "" })).toBeNull();
  });

  test("parses the three together, header names lowercased", () => {
    expect(parseClientIpHeaderTrust(env)).toEqual({
      header: "x-azure-clientip",
      secretHeader: "x-azure-fdid",
      secret: FDID,
    });
  });

  test.each([
    [{ GEMI_CLIENT_IP_HEADER: "x-azure-clientip" }, /go together/],
    [{ ...env, GEMI_PROXY_SECRET: undefined }, /go together/],
    [{ ...env, GEMI_PROXY_SECRET_HEADER: undefined }, /go together/],
    [{ GEMI_PROXY_SECRET_HEADER: "x-azure-fdid", GEMI_PROXY_SECRET: FDID }, /go together/],
    [{ ...env, GEMI_CLIENT_IP_HEADER: "x-a, x-b" }, /GEMI_CLIENT_IP_HEADER must be/],
    [{ ...env, GEMI_PROXY_SECRET_HEADER: "x y" }, /GEMI_PROXY_SECRET_HEADER must be/],
    [{ ...env, GEMI_PROXY_SECRET_HEADER: "x-azure-clientip" }, /same header/],
    [{ ...env, GEMI_PROXY_SECRET: "short" }, /at least 16/],
  ])("a bad set fails the boot: %j", (value, message) => {
    expect(() => parseClientIpHeaderTrust(value)).toThrow(message);
  });

  const trust = parseClientIpHeaderTrust(env)!;
  const ip = (headers: Record<string, string>) => trustedHeaderClientIp(new Headers(headers), trust);

  test("the header is believed with the matching FDID", () => {
    expect(ip({ "x-azure-clientip": "203.0.113.9", "x-azure-fdid": FDID })).toBe("203.0.113.9");
    expect(ip({ "x-azure-clientip": "2001:db8::9", "x-azure-fdid": FDID })).toBe("2001:db8::9");
  });

  test("a wrong or missing FDID is never believed", () => {
    expect(ip({ "x-azure-clientip": "203.0.113.9" })).toBeNull();
    expect(ip({ "x-azure-clientip": "203.0.113.9", "x-azure-fdid": "another-profile-0000000000" })).toBeNull();
    expect(ip({ "x-azure-clientip": "203.0.113.9", "x-azure-fdid": `${FDID}x` })).toBeNull();
  });

  test("a value that is not an address is ignored", () => {
    expect(ip({ "x-azure-clientip": "unknown", "x-azure-fdid": FDID })).toBeNull();
    expect(ip({ "x-azure-fdid": FDID })).toBeNull();
  });

  test("ip:port and [v6]:port values lose their port", () => {
    expect(ip({ "x-azure-clientip": "203.0.113.9:51234", "x-azure-fdid": FDID })).toBe("203.0.113.9");
    expect(ip({ "x-azure-clientip": "[2001:db8::9]:443", "x-azure-fdid": FDID })).toBe("2001:db8::9");
  });
});
