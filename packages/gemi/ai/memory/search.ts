import type { AgentMemoryRecord } from "./AgentMemoryStore";

/** How many memories `recall` answers when it is not told. */
export const DEFAULT_RECALL_LIMIT = 8;

/**
 * Words too common to say anything about which memory is meant. English only,
 * and short on purpose: a word left in costs a little ranking noise, a word
 * wrongly taken out makes a memory unfindable.
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by do does for from has have he her his i if in into is it its " +
    "me my of on or our she so that the their them they this to us was we were what when where " +
    "which who will with you your"
  ).split(" "),
);

/**
 * Lowercased words with their accents folded, so "Öztürk" finds "ozturk" and
 * "Cafe" finds "café". Letters and digits of any script count as word
 * characters.
 */
export function tokenize(text: string): string[] {
  const folded = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  return (folded.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !STOPWORDS.has(word));
}

/**
 * Keyword search over a scope's memories (#936 P1): BM25 over each memory's
 * content, key and tags, with a word that only starts the same way ("photo",
 * "photos") counted at half weight, and a small bonus for the more recently
 * changed memory to break ties.
 *
 * In JavaScript rather than in SQL because a scope is small (a couple of
 * hundred memories at most) and the same code then ranks the same way on
 * every database. A store may answer `search` with something better.
 *
 * Only memories that match at least one word are returned, best first.
 */
export function rankMemories(
  records: readonly AgentMemoryRecord[],
  query: string,
  limit: number = DEFAULT_RECALL_LIMIT,
): AgentMemoryRecord[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || records.length === 0) return [];

  const docs = records.map((record) =>
    tokenize([record.content, record.key ?? "", record.tags.join(" ")].join(" ")),
  );
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const k1 = 1.2;
  const b = 0.75;

  const weightIn = (doc: string[], term: string): number => {
    let weight = 0;
    for (const word of doc) {
      if (word === term) weight += 1;
      else if (term.length >= 3 && (word.startsWith(term) || term.startsWith(word))) {
        if (Math.min(word.length, term.length) >= 3) weight += 0.5;
      }
    }
    return weight;
  };

  const frequencies = docs.map((doc) => terms.map((term) => weightIn(doc, term)));
  const idf = terms.map((_, t) => {
    const containing = frequencies.filter((row) => row[t]! > 0).length;
    return Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5));
  });

  const newest = Math.max(...records.map((record) => record.updatedAt));
  const oldest = Math.min(...records.map((record) => record.updatedAt));
  const span = newest - oldest || 1;

  const scored = records
    .map((record, at) => {
      const doc = docs[at]!;
      let score = 0;
      terms.forEach((_, t) => {
        const tf = frequencies[at]![t]!;
        if (tf === 0) return;
        score += idf[t]! * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / averageLength)));
      });
      if (score === 0) return { record, score };
      // A few hundredths at most: enough to order two equally good matches,
      // rarely enough to lift a worse one.
      score += 0.05 * ((record.updatedAt - oldest) / span);
      return { record, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1));

  return scored.slice(0, Math.max(0, Math.floor(limit))).map((entry) => entry.record);
}
