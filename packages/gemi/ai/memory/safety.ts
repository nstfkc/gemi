/**
 * What an agent's memory write is checked against before it is stored
 * (#936): the text has to be a short note and must not look like a secret.
 *
 * A memory is shown to the model on every later turn and to the user in the
 * app's memory screen, and it outlives the conversation it came from. A
 * password or an API key the user pasted once must not become one. The
 * patterns below are the common shapes; `AgentMemories.use(store, {
 * beforeWrite })` is where an app adds its own.
 */

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "an API key", pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/ },
  { name: "an API key", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "an API key", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "an API key", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "an API key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "an API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "a token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "a token", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  {
    name: "a password",
    pattern:
      /\b(?:password|passwd|passcode|pwd|api[ _-]?key|access[ _-]?token|auth[ _-]?token|secret[ _-]?key|client[ _-]?secret)\s*[:=]\s*\S{4,}/i,
  },
  // "The password is …" is nearly always one. Not "the secret is …" or "the
  // token is …": "our secret is fresh bread" is a fact worth keeping.
  { name: "a password", pattern: /\b(?:password|passwd|passcode)\s+(?:is|was)\s+\S{4,}/i },
  { name: "a PIN", pattern: /\bpin(?: code)?\s*(?:is|:|=)?\s*\d{4,8}\b/i },
];

/**
 * Why `content` must not be stored, or `null` when it may be: "an API key",
 * "a card number", and so on. Never the matched text itself.
 */
export function secretIn(content: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) return name;
  }
  if (hasCardNumber(content)) return "a card number";
  if (hasIban(content)) return "a bank account number (IBAN)";
  return null;
}

/** 13 to 19 digits, spaces or dashes between them allowed, that pass the Luhn check. */
function hasCardNumber(content: string): boolean {
  for (const match of content.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** A country code, two check digits and 11–30 letters or digits, that pass the mod-97 check. */
function hasIban(content: string): boolean {
  for (const match of content.toUpperCase().matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g)) {
    const iban = match[0].replace(/ /g, "");
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let remainder = 0;
    for (const char of rearranged) {
      const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
      for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    if (remainder === 1) return true;
  }
  return false;
}

/** One line of text: whitespace and newlines collapsed, trimmed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Text as it may sit inside the `<memory>` block. A memory is the user's (or
 * a web page's) words, so anything that could close the block or open
 * another one (`</memory>`, `<system>`) is escaped, and it is kept to one line.
 */
export function blockText(text: string): string {
  return oneLine(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Two contents that differ only in case, spacing and closing punctuation. */
export function normalizedContent(text: string): string {
  return oneLine(text)
    .toLowerCase()
    .replace(/[.!?…\s]+$/u, "");
}

/** `business.hours`, `brand.voice`: letters, digits and `._:-`, at most 100. */
export const MEMORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** `fact`, `preference`, an app's own: lowercase letters, digits, `_` and `-`, at most 32. */
export const MEMORY_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** A tag: like a key, at most 32. */
export const MEMORY_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
/** How many tags a memory may carry. */
export const MAX_MEMORY_TAGS = 10;
