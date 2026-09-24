import { useContext } from "react";
import { ServerDataContext } from "./ServerDataProvider";
import { domainUrl, type DomainTarget } from "../utils/domainUrl";

/**
 * The `route.domains` group this page was served under — `params.tenant` on
 * `acme.example.com` — and `url()` for linking to another of the app's hosts.
 * Empty when the app declares no `route.domains`.
 *
 * Hand `url()`'s result to `Link` or `navigate`: a URL on another host is a
 * full page load, not a client-side navigation.
 */
export function useDomain() {
  const domain = useContext(ServerDataContext).router?.domain ?? null;
  return {
    host: domain?.host ?? null,
    group: domain?.group ?? null,
    params: domain?.params ?? {},
    custom: domain?.custom ?? false,
    url(target: DomainTarget, path = "/") {
      if (!domain?.root) {
        throw new Error("`useDomain().url` needs `route.domains` to be configured.");
      }
      // The origin the server saw, not `window.location`: the two agree, and
      // this one exists during the server render too, so hydration matches.
      return domainUrl({ root: domain.root, origin: domain.origin }, target, path);
    },
  };
}
