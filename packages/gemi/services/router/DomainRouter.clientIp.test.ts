import { describe, expect, test } from "vitest";

import { withheldFromUpstream } from "../../http/requestDomain";
import { parseClientIpHeaderTrust } from "../../server/forwardedFor";
import { DomainRouter } from "./DomainRouter";
import type { DomainsConfig } from "./config";

/**
 * `DomainRouter.applyClientIp`, which `App.applyTrustedClientIp` calls: the
 * client-IP header without `route.domains` (`GEMI_CLIENT_IP_HEADER`, #958)
 * and with it (`route.domains.trustProxy.clientIpHeader`, #917).
 */

const FDID = "8a2b1c3d-0000-4e5f-9a8b-123456789abc";
const PROXY_SECRET = "proxy-secret-long-enough";

const frontDoor = parseClientIpHeaderTrust({
  GEMI_CLIENT_IP_HEADER: "x-azure-clientip",
  GEMI_PROXY_SECRET_HEADER: "x-azure-fdid",
  GEMI_PROXY_SECRET: FDID,
});

function router(extra: { domains?: DomainsConfig; clientIpTrust?: typeof frontDoor } = {}) {
  return new DomainRouter({ api: {}, view: {} } as never, {
    api: {} as never,
    view: {} as never,
    ...extra,
  });
}

function applied(r: DomainRouter, headers: Record<string, string>) {
  const req = new Request("http://folio.azurewebsites.net/", { headers });
  r.applyClientIp(req);
  return {
    forwardedFor: req.headers.get("x-forwarded-for"),
    realIp: req.headers.get("x-real-ip"),
    withheld: withheldFromUpstream(req),
  };
}

describe("GEMI_CLIENT_IP_HEADER without route.domains (#958)", () => {
  test("with the matching FDID, X-Azure-ClientIP becomes the client", () => {
    expect(
      applied(router({ clientIpTrust: frontDoor }), {
        "x-azure-clientip": "203.0.113.9",
        "x-azure-fdid": FDID,
        "x-forwarded-for": "169.254.0.1",
        "x-real-ip": "6.6.6.6",
      }),
    ).toEqual({ forwardedFor: "203.0.113.9", realIp: null, withheld: ["x-azure-fdid"] });
  });

  test("a wrong or missing FDID keeps the address GEMI_TRUST_PROXY settled on", () => {
    for (const fdid of [undefined, "another-front-door-profile-id"]) {
      expect(
        applied(router({ clientIpTrust: frontDoor }), {
          "x-azure-clientip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.4",
          ...(fdid ? { "x-azure-fdid": fdid } : {}),
        }).forwardedFor,
      ).toBe("198.51.100.4");
    }
  });

  test("a value that is not an address changes nothing", () => {
    expect(
      applied(router({ clientIpTrust: frontDoor }), {
        "x-azure-clientip": "not-an-ip",
        "x-azure-fdid": FDID,
        "x-forwarded-for": "198.51.100.4",
      }).forwardedFor,
    ).toBe("198.51.100.4");
  });

  test("ip:port and [v6]:port values lose their port", () => {
    const r = router({ clientIpTrust: frontDoor });
    expect(
      applied(r, { "x-azure-clientip": "203.0.113.9:51234", "x-azure-fdid": FDID }).forwardedFor,
    ).toBe("203.0.113.9");
    expect(
      applied(r, { "x-azure-clientip": "[2001:db8::9]:443", "x-azure-fdid": FDID }).forwardedFor,
    ).toBe("2001:db8::9");
  });

  test("is off unless configured", () => {
    expect(
      applied(router(), {
        "x-azure-clientip": "203.0.113.9",
        "x-azure-fdid": FDID,
        "x-forwarded-for": "198.51.100.4",
      }),
    ).toEqual({ forwardedFor: "198.51.100.4", realIp: null, withheld: [] });
  });
});

describe("route.domains.trustProxy.clientIpHeader still applies (#917)", () => {
  const domains: DomainsConfig = {
    root: "example.com",
    trustProxy: {
      clientIpHeader: "x-client-ip",
      secret: { header: "x-proxy-secret", value: PROXY_SECRET },
    },
  };

  test("with its secret", () => {
    expect(
      applied(router({ domains }), {
        "x-client-ip": "203.0.113.9",
        "x-proxy-secret": PROXY_SECRET,
        "x-forwarded-for": "198.51.100.4",
      }).forwardedFor,
    ).toBe("203.0.113.9");
  });

  test("without it", () => {
    expect(
      applied(router({ domains }), {
        "x-client-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.4",
      }).forwardedFor,
    ).toBe("198.51.100.4");
  });

  test("alongside GEMI_CLIENT_IP_HEADER, whichever proxy proves itself names the client", () => {
    const r = router({ domains, clientIpTrust: frontDoor });
    expect(
      applied(r, { "x-client-ip": "203.0.113.9", "x-proxy-secret": PROXY_SECRET }).forwardedFor,
    ).toBe("203.0.113.9");
    expect(
      applied(r, { "x-azure-clientip": "203.0.113.10", "x-azure-fdid": FDID }).forwardedFor,
    ).toBe("203.0.113.10");
  });
});

describe("route.domains.trustProxy as a list (#1013)", () => {
  const domains: DomainsConfig = {
    root: "example.com",
    trustProxy: [
      {
        hostHeader: "x-original-host",
        clientIpHeader: "x-client-ip",
        secret: { header: "x-proxy-secret", value: PROXY_SECRET },
      },
      { clientIpHeader: "x-azure-clientip", secret: { header: "x-azure-fdid", value: FDID } },
    ],
  };
  const workerThenFrontDoor = {
    "x-client-ip": "203.0.113.9",
    "x-proxy-secret": PROXY_SECRET,
    "x-azure-clientip": "104.28.0.1",
    "x-azure-fdid": FDID,
    "x-forwarded-for": "104.28.0.1",
    "x-real-ip": "104.28.0.1",
  };

  test("Worker -> Front Door -> app: the buyer, from the Worker's header", () => {
    expect(applied(router({ domains }), workerThenFrontDoor)).toMatchObject({
      forwardedFor: "203.0.113.9",
      realIp: null,
    });
  });

  test("Front Door -> app: the user, from Front Door's header", () => {
    expect(
      applied(router({ domains }), {
        "x-azure-clientip": "198.51.100.7",
        "x-azure-fdid": FDID,
        "x-forwarded-for": "169.254.0.1",
      }).forwardedFor,
    ).toBe("198.51.100.7");
  });

  test("neither secret: the address GEMI_TRUST_PROXY settled on", () => {
    expect(
      applied(router({ domains }), {
        "x-client-ip": "6.6.6.6",
        "x-azure-clientip": "6.6.6.7",
        "x-forwarded-for": "198.51.100.4",
      }).forwardedFor,
    ).toBe("198.51.100.4");
  });

  test("GEMI_CLIENT_IP_HEADER stays the fallback for a request no entry names the client for", () => {
    const r = router({
      domains: {
        root: "example.com",
        trustProxy: [
          {
            clientIpHeader: "x-client-ip",
            secret: { header: "x-proxy-secret", value: PROXY_SECRET },
          },
        ],
      },
      clientIpTrust: frontDoor,
    });
    expect(applied(r, workerThenFrontDoor).forwardedFor).toBe("203.0.113.9");
    expect(
      applied(r, { "x-azure-clientip": "198.51.100.7", "x-azure-fdid": FDID }).forwardedFor,
    ).toBe("198.51.100.7");
    expect(applied(r, { "x-azure-clientip": "6.6.6.6" }).forwardedFor).toBeNull();
  });
});
