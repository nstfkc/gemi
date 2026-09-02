import type { ProviderCapabilities } from "../AgentProvider";

/**
 * What a model can do, read off its id.
 *
 * Hardcoding `true` was never an option — `reasoning: { effort }` is a 400 on
 * gpt-4o, and `defer_loading` is a 400 on anything that predates tool search —
 * but neither is a table lookup that only answers for ids we shipped knowing
 * about.
 *
 * SO AN UNKNOWN ID GETS EVERY CAPABILITY. That is the whole point: a model
 * released next Tuesday must be usable by writing its name, not by waiting for
 * a gemi release. The default is chosen for how it fails, not for how often it
 * is right. Guessing high fails loudly and once — the API rejects the request
 * and names the parameter it disliked, and the fix is one line of config.
 * Guessing low fails silently and forever: reasoning is dropped, every deferred
 * schema is inlined, and the only symptom is a bigger bill and a worse answer.
 * Unknown ids also skew new rather than old, because nobody invents the name of
 * a model that already shipped.
 *
 * The named families below exist to make the *known-old* cases right, which is
 * the only place a guess can be wrong in the quiet direction.
 */
export function capabilitiesForModel(model: string): ProviderCapabilities {
  const id = normalizeModelId(model);

  // Everything before the tool-era models. Listed by prefix because these names
  // are closed sets now — nothing new will be called `gpt-3.5-*`.
  if (id.startsWith("gpt-3.5") || id.startsWith("text-") || id.startsWith("davinci")) {
    return {
      reasoning: false,
      structuredOutput: false,
      fileInput: false,
      parallelToolCalls: true,
      toolSearch: false,
    };
  }

  const family = parseFamily(id);

  // o1 reasons but takes its tool calls one at a time; o3/o4 do not have that
  // restriction. Both predate tool search.
  if (family?.kind === "o") {
    return {
      reasoning: true,
      structuredOutput: true,
      fileInput: true,
      parallelToolCalls: family.major > 1,
      toolSearch: family.major >= 5,
    };
  }

  if (family?.kind === "gpt") {
    return {
      // gpt-4 and gpt-4o are strong models with no reasoning parameter at all.
      reasoning: family.major >= 5,
      // Strict `json_schema` landed with gpt-4o; plain gpt-4 only has json_object.
      structuredOutput: family.major > 4 || id.startsWith("gpt-4o") || id.startsWith("gpt-4.1"),
      fileInput: family.major > 4 || id.startsWith("gpt-4o") || id.startsWith("gpt-4.1"),
      parallelToolCalls: true,
      // Tool search is recent-model-only.
      toolSearch: family.major >= 5,
    };
  }

  return {
    reasoning: true,
    structuredOutput: true,
    fileInput: true,
    parallelToolCalls: true,
    toolSearch: true,
  };
}

/**
 * Azure deployment names are chosen by whoever ran the ARM template, so half of
 * them look nothing like a model id. That is not a special case here: an
 * unrecognizable deployment name lands on the same all-true default as an
 * unrecognized model, for the same reason.
 */
function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

type Family = { kind: "gpt" | "o"; major: number };

/**
 * Reads the generation number out of `gpt-5.4-mini-2025-01-01` or `o3-mini`.
 * Only the major number is used — a point release has never taken a capability
 * away, and treating `gpt-5.1` as unknown-therefore-capable would be the same
 * answer anyway.
 */
function parseFamily(id: string): Family | null {
  const gpt = /^gpt-(\d+)/.exec(id);
  if (gpt?.[1]) return { kind: "gpt", major: Number(gpt[1]) };
  // `o1`, `o3-mini`, `o4-mini`. Anchored and followed by a boundary so
  // `omni-moderation` does not read as generation 0.
  const o = /^o(\d+)(?:[-.]|$)/.exec(id);
  if (o?.[1]) return { kind: "o", major: Number(o[1]) };
  return null;
}
