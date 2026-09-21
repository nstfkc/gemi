import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GenerateClientError, extractAgent, loadTypeScript, parseAgentReference } from "./extract";
import { renderSwift } from "./swift";

export { GenerateClientError } from "./extract";

export const PLATFORMS = ["swift", "kotlin"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type GenerateClientOptions = {
  /** `<file>#<export>`, relative to `cwd`. */
  agent: string;
  /** The directory the file is written to, relative to `cwd`. */
  out: string;
  platform: string;
  /** The generated type's name. Defaults to the export's, pascal-cased. */
  name?: string;
  cwd?: string;
};

export type GenerateClientResult = { file: string; warnings: string[] };

/** `gemi ai:generate-client`: one agent, one file. */
export async function generateClient(
  options: GenerateClientOptions,
): Promise<GenerateClientResult> {
  const cwd = options.cwd ?? process.cwd();
  const platform = parsePlatform(options.platform);
  if (platform === "kotlin") {
    throw new GenerateClientError(
      "--platform kotlin is not available yet: the Kotlin client it would target has not " +
        "shipped. Swift is ready.",
    );
  }
  const ts = await loadTypeScript(cwd);
  const model = extractAgent(ts, parseAgentReference(options.agent), { cwd, name: options.name });

  const directory = path.resolve(cwd, options.out);
  const file = path.join(directory, `${model.name}.swift`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, renderSwift(model));
  return { file, warnings: model.warnings };
}

function parsePlatform(platform: string): Platform {
  if ((PLATFORMS as readonly string[]).includes(platform)) return platform as Platform;
  throw new GenerateClientError(
    `--platform must be one of ${PLATFORMS.join(", ")} — got "${platform}".`,
  );
}
