import { describe, expect, test } from "vitest";

import { clientIp } from "../http/RateLimitMiddleware";
import {
  applyForwardedTrust,
  type ForwardedTrust,
  parseTrustProxy,
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
