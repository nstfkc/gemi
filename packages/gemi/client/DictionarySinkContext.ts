import { createContext } from "react";
import type { DictionarySink } from "../i18n/dictionarySink";

/**
 * The SSR-only collector `useDictionary` reports into. `null` in the browser,
 * where nothing needs collecting — the strings are already there.
 *
 * Mirrors `ServerQueryContext`: a server-supplied per-request object handed to
 * the tree by `createRoot`.
 */
export const DictionarySinkContext = createContext<DictionarySink | null>(null);
