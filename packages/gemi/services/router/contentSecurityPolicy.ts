import { cspHashOf } from "./documentScript";

/** See `ViewRouteConfig.csp`. */
export interface StrictCspOptions {
  /**
   * Send the policy as `Content-Security-Policy-Report-Only`: violations are
   * reported (and logged in the console) but nothing is blocked. For trying
   * the policy on a live app first.
   */
  reportOnly?: boolean;
  /** Where browsers report violations, as the policy's `report-uri`. */
  reportUri?: string;
}

const CSP_HEADER = "Content-Security-Policy";
const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/**
 * The strict policy (#1195): scripts run only when they carry this response's
 * nonce (or match one of `hashes`), and `'strict-dynamic'` passes that trust on
 * to what they load, so the client entry's `import()`s, the route chunks and
 * island modules need no allowlist, wherever the assets are served from.
 * `object-src 'none'` and `base-uri 'self'` close the two other ways around a
 * script policy. Styles, images, fonts and connections are left alone.
 */
export function strictCspPolicy(
  sources: { nonce?: string; hashes?: string[] },
  options: StrictCspOptions = {},
): string {
  const scriptSources = [
    ...(sources.nonce ? [`'nonce-${sources.nonce}'`] : []),
    ...(sources.hashes ?? []),
  ];
  const directives = [
    // Nothing to allow (a static page without scripts): nothing runs.
    scriptSources.length > 0 ? `script-src ${scriptSources.join(" ")} 'strict-dynamic'` : "script-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ];
  if (options.reportUri) {
    directives.push(`report-uri ${options.reportUri}`);
  }
  return directives.join("; ");
}

/**
 * Sets the strict policy on a document's headers when the views opted in
 * (`csp`), unless the app already set a policy of its own, which wins.
 */
export function applyStrictCsp(
  headers: Headers,
  csp: boolean | StrictCspOptions | undefined,
  sources: { nonce?: string; inlineScripts?: string[] },
) {
  if (!csp) return;
  if (headers.has(CSP_HEADER) || headers.has(CSP_REPORT_ONLY_HEADER)) return;
  const options = csp === true ? {} : csp;
  headers.set(
    options.reportOnly ? CSP_REPORT_ONLY_HEADER : CSP_HEADER,
    strictCspPolicy(
      { nonce: sources.nonce, hashes: [...new Set(sources.inlineScripts ?? [])].map(cspHashOf) },
      options,
    ),
  );
}
