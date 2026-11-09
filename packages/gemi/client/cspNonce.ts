import { createContext, useContext } from "react";

/**
 * The request's CSP nonce while the view router renders a hydrated page on the
 * server (#1195). `null` in the browser, which reads it off the document
 * instead, and in a static view, which has none.
 */
export const CspNonceContext = createContext<string | null>(null);

let documentNonce: string | undefined;

/**
 * The nonce the server rendered this document with, read from a script that
 * carries one. Browsers hide a nonce from `getAttribute` (and from CSS
 * selectors) once the element is in the document, but not from the `nonce`
 * property, which is what this reads. `undefined` on a page without one.
 */
export function readDocumentNonce(): string | undefined {
  if (documentNonce !== undefined || typeof document === "undefined") {
    return documentNonce;
  }
  const script = document.querySelector<HTMLScriptElement>("script[nonce]");
  documentNonce = script?.nonce || script?.getAttribute("nonce") || undefined;
  return documentNonce;
}

/** Gives `element` the document's nonce, for one gemi adds to the page itself. */
export function applyDocumentNonce(element: HTMLElement) {
  const nonce = readDocumentNonce();
  if (nonce) {
    element.nonce = nonce;
  }
}

/**
 * The page's CSP nonce, for an inline `<script>` or `<style>` the app renders
 * itself: the same one gemi puts on its own, so a strict policy
 * (`csp: true` in the view config, or the app's own header built from
 * `cspNonce()`) lets it run.
 *
 * ```tsx
 * const nonce = useCspNonce();
 * <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: snippet }} />
 * ```
 *
 * `suppressHydrationWarning` because the browser hides the attribute's value
 * once the page loads, so React would otherwise report a mismatch while
 * hydrating. `undefined` in a static view (which uses hashes, not nonces) and
 * on a page rendered without one.
 */
export function useCspNonce(): string | undefined {
  return useContext(CspNonceContext) ?? readDocumentNonce();
}
