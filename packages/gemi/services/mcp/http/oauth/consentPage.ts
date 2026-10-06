import type { McpConsent } from "./McpOAuthServer";

/**
 * Headers for any page that asks for consent: it must never be framed (a
 * framed "Allow" button can be clicked through an overlay), cached, or leak
 * its URL — which carries the request — in a `Referer`.
 */
export const CONSENT_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  // No `form-action`: browsers apply it to the redirect that follows the
  // decision, which goes to the client's own redirect URI.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/** The consent page gemi serves when the app has no `consentPath` of its own. */
export function consentPage(consent: McpConsent, app: { name: string }): string {
  const name = consent.client.name ? escape(consent.client.name) : "An application";
  const scopes = consent.scopes
    .map((scope) => `<li><strong>${escape(scope.name)}</strong><br><span>${escape(scope.description)}</span></li>`)
    .join("");
  const hidden = Object.entries(consent.form.fields)
    .map(([field, value]) => `<input type="hidden" name="${escape(field)}" value="${escape(value)}">`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to ${escape(app.name)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }
  main { max-width: 440px; width: 100%; border: 1px solid #8884; border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.2rem; margin: 0 0 12px; }
  p, li { line-height: 1.45; }
  .warn { font-size: .9rem; opacity: .8; }
  ul { padding-left: 20px; }
  li span { opacity: .8; }
  .actions { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #8886; font-size: 1rem; cursor: pointer; }
  button[value=allow] { background: #2563eb; color: #fff; border-color: #2563eb; }
</style>
</head>
<body>
<main>
  <h1>${name} wants to access your ${escape(app.name)} account</h1>
  <p class="warn">Signed in as ${escape(consent.user.label)}. After you allow it, you will be sent to <strong>${escape(consent.client.redirectHost)}</strong>. The name above was given by the application and is not verified. Only continue if you started this connection yourself.</p>
  <p>It will be able to:</p>
  <ul>${scopes}</ul>
  <form method="post" action="${escape(consent.form.action)}">
    ${hidden}
    <div class="actions">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

/** A plain page for an authorization request that cannot be sent back to the client. */
export function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorization failed</title></head><body style="font-family: system-ui, sans-serif; padding: 24px"><h1 style="font-size: 1.2rem">This connection could not be authorized</h1><p>${escape(message)}</p></body></html>`;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
