/**
 * Where one browser keeps a user's conversation between visits.
 *
 * The key carries the user, because a browser is not a person: two accounts
 * that sign in on the same machine must not open each other's thread. And
 * signing out removes every key under the prefix, so what the last person was
 * talking about does not sit in the next person's storage either.
 */
const PREFIX = "agentic-saas.support-thread";

export function threadStorageKey(userKey: string) {
  return `${PREFIX}:${userKey}`;
}

export function clearAllStoredThreads() {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key === PREFIX || key.startsWith(`${PREFIX}:`)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage that cannot be read holds nothing to clear.
  }
}
