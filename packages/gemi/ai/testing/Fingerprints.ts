import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * What a recording was made with, kept on it (`Recording.fingerprints`):
 *
 * - `prompts`: each prompt file whose text the requests carried, by its path
 *   from `root`, as its git blob id, so the version it was recorded with can
 *   be read back from git;
 * - `tools`: each tool the requests offered, by name, as the hashes of its
 *   definitions (description and parameters);
 * - `inputs`: anything else the app says the recording depends on
 *   (`FingerprintOptions.inputs`), such as the schemas behind generated
 *   tools, hashed by name.
 */
export type RecordingFingerprints = {
  prompts: Record<string, string>;
  tools: Record<string, string[]>;
  inputs?: Record<string, string>;
};

/** Where a recording's prompt files are, and how to read their recorded versions back. */
export type FingerprintOptions = {
  /** The repository root that paths are relative to, and git runs in. Default the working directory. */
  root?: string;
  /** The folders, relative to `root`, that prompt files (`*.md`) live in. Default `["app/agents"]`, gemi's. */
  dirs?: string[];
  /** The folder under a prompt folder that a bare partial name (`{{> tone}}`) resolves in. Default `prompts`, as `Prompt.render`. */
  shared?: string;
  /**
   * A prompt file's text by its git blob id, for the version a recording was
   * made with. Default `git cat-file blob <id>` in `root`. `undefined` when it
   * can't be found.
   */
  readBlob?: (blob: string) => string | undefined;
  /**
   * Other inputs the recording depends on, hashed by name, given the names of
   * the tools its requests offered: the component schemas behind generated
   * `add_` tools, say. Called when recording, and again to tell what changed.
   */
  inputs?: (tools: ReadonlySet<string>) => Record<string, string>;
};

/** What a piece of a prompt's static text is replaced with when it is cut out of a request. */
const CUT = "␟";
/** Prompt text shorter than this is cut only next to a cut: it could be part of a value as well. */
const SHORTEST = 6;
const PARTIAL = /\{\{>\s*([^}\s]+)\s*\}\}/g;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cuts `pieces` of prompt text out of a text, leaving a mark (and no
 * whitespace) where each was. A short piece (a full stop between a
 * placeholder and a partial) is cut only where it touches a cut.
 */
function cutOut(pieces: string[]): (text: string) => string {
  const long = pieces.filter((piece) => piece.length >= SHORTEST);
  const short = pieces.filter((piece) => piece.length < SHORTEST);
  return (text) => {
    let left = text;
    for (const piece of long) if (left.includes(piece)) left = left.split(piece).join(CUT);
    for (const piece of short) {
      left = left
        .replace(new RegExp(`${escape(piece)}\\s*${CUT}`, "g"), CUT)
        .replace(new RegExp(`${CUT}\\s*${escape(piece)}`, "g"), CUT);
    }
    return left.replace(new RegExp(`\\s*${CUT}[\\s${CUT}]*`, "g"), CUT);
  };
}

function scan(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) scan(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

/**
 * A recording's fingerprints, and what they tell about it today: which of the
 * prompts, tools and inputs it was made with have changed (`changed`), and how
 * to compare a request across a prompt's rewording (`cutters`).
 *
 * A replayed call whose request differs only in the wording of the prompt
 * files changed since the recording is stale, not a mismatch: the static text
 * of those files is cut out of both sides (the recorded version, read back from
 * git, out of the recorded request; today's out of the replay's), so the
 * messages, the tool calls and results and every value filled into the
 * prompts must still be the same.
 */
export class Fingerprints {
  readonly root: string;
  private readonly options: FingerprintOptions;

  constructor(
    readonly data: RecordingFingerprints,
    options: FingerprintOptions = {},
  ) {
    this.options = options;
    this.root = options.root ?? process.cwd();
  }

  /** A text's git blob id (`git hash-object`). */
  static blob(text: string): string {
    return createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest("hex");
  }

  /** A prompt's static text: the pieces between its placeholders and partials. */
  static pieces(text: string): string[] {
    return text
      .split(/\{\{[^}]*\}\}/)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
  }

  /** A tool definition's hash, as `tools` keeps it. */
  static tool(tool: { description?: string; parameters?: unknown }): string {
    return createHash("sha256")
      .update(JSON.stringify({ description: tool.description, parameters: tool.parameters }))
      .digest("hex");
  }

  /** The prompt files under the configured folders today, by path from `root`. */
  static prompts(options: FingerprintOptions = {}): Map<string, string> {
    const root = options.root ?? process.cwd();
    const prompts = new Map<string, string>();
    for (const dir of options.dirs ?? ["app/agents"]) {
      if (!existsSync(join(root, dir))) continue;
      for (const path of scan(join(root, dir)).sort()) {
        prompts.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
      }
    }
    return prompts;
  }

  /**
   * The fingerprints of what requests sent: `texts`, every string they
   * carried, and `tools`, each tool's definition hashes by name. A prompt file
   * counts as sent when one of its three longest pieces of static text (of 12
   * characters or more) is in `texts`.
   */
  static of(
    texts: Iterable<string>,
    tools: ReadonlyMap<string, ReadonlySet<string>>,
    options: FingerprintOptions = {},
  ): Fingerprints {
    const sent = [...texts].join("\n\0\n");
    const prompts: Record<string, string> = {};
    for (const [path, text] of Fingerprints.prompts(options)) {
      const longest = Fingerprints.pieces(text)
        .filter((piece) => piece.length >= 12)
        .sort((a, b) => b.length - a.length)
        .slice(0, 3);
      if (longest.some((piece) => sent.includes(piece))) prompts[path] = Fingerprints.blob(text);
    }
    const names = [...tools.keys()].sort();
    const inputs = options.inputs?.(new Set(names));
    return new Fingerprints(
      {
        prompts,
        tools: Object.fromEntries(names.map((name) => [name, [...tools.get(name)!].sort()])),
        ...(inputs && Object.keys(inputs).length > 0 ? { inputs: sortKeys(inputs) } : {}),
      },
      options,
    );
  }

  /** Whether `other` says the same. */
  same(other: Fingerprints | RecordingFingerprints): boolean {
    const data = other instanceof Fingerprints ? other.data : other;
    return JSON.stringify(this.data) === JSON.stringify(data);
  }

  /**
   * What differs today from what the recording was made with, without running
   * anything: each prompt file changed or gone (its path) and each input
   * changed or gone (`input <name>`). Tools defined in code are compared by a
   * replay, which offers them.
   */
  changed(): string[] {
    const today = this.options.inputs?.(new Set(Object.keys(this.data.tools))) ?? {};
    return [
      ...this.changedPrompts().map(([path]) => path),
      ...Object.entries(this.data.inputs ?? {})
        .filter(([name, hash]) => today[name] !== hash)
        .map(([name]) => `input ${name}`),
    ];
  }

  /**
   * How each side of a differing request is cut before the two are compared:
   * the static text of every prompt file changed since the recording (and of
   * the partials each version of it includes) is cut out, the recorded
   * version's from the recorded request and today's from the replay's.
   * `changed` names those files. Throws when a changed prompt's recorded
   * version can't be read back.
   */
  cutters(): {
    changed: string[];
    recorded: (text: string) => string;
    sent: (text: string) => string;
  } {
    const today = Fingerprints.prompts(this.options);
    const changed = this.changedPrompts();
    const recorded = new Map<string, string>();
    const sent = new Map<string, string>();
    for (const [path, blob] of changed) {
      const text = this.readBlob(blob);
      if (text === undefined) {
        throw new Error(
          `${path} changed since the recording, and the version it was recorded with (${blob}) can't be read back from git`,
        );
      }
      recorded.set(path, text);
      if (today.has(path)) sent.set(path, today.get(path)!);
    }
    return {
      changed: changed.map(([path]) => path),
      recorded: cutOut(
        this.piecesWithPartials(recorded, (path) => {
          const blob = this.data.prompts[path];
          return (blob && this.readBlob(blob)) || today.get(path);
        }),
      ),
      sent: cutOut(this.piecesWithPartials(sent, (path) => today.get(path))),
    };
  }

  /** The prompt files that changed or are gone since the recording, with their recorded blob ids. */
  private changedPrompts(): [string, string][] {
    const today = Fingerprints.prompts(this.options);
    return Object.entries(this.data.prompts).filter(([path, blob]) => {
      const text = today.get(path);
      return text === undefined || Fingerprints.blob(text) !== blob;
    });
  }

  private readBlob(blob: string): string | undefined {
    if (this.options.readBlob) return this.options.readBlob(blob);
    const git = Bun.spawnSync(["git", "cat-file", "blob", blob], { cwd: this.root });
    return git.exitCode === 0 ? git.stdout.toString() : undefined;
  }

  /**
   * The static text of `texts` and of the partials each includes, longest
   * first: moving text into a partial is a change of wording too. Partials
   * resolve as `Prompt.render` resolves them.
   */
  private piecesWithPartials(
    texts: Map<string, string>,
    version: (path: string) => string | undefined,
  ): string[] {
    const dirs = this.options.dirs ?? ["app/agents"];
    const shared = this.options.shared ?? "prompts";
    const pending = [...texts];
    while (pending.length > 0) {
      const [path, text] = pending.pop()!;
      const dir = dirs.find((d) => path.startsWith(`${d}/`));
      if (dir === undefined) continue;
      for (const [, name] of text.matchAll(PARTIAL)) {
        const partial = `${dir}/${name!.includes("/") ? name : `${shared}/${name}`}.md`;
        const body = texts.has(partial) ? undefined : version(partial);
        if (body === undefined) continue;
        texts.set(partial, body);
        pending.push([partial, body]);
      }
    }
    return [...texts.values()]
      .flatMap((text) => Fingerprints.pieces(text))
      .sort((a, b) => b.length - a.length);
  }
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
