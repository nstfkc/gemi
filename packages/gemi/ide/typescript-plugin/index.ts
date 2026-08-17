import type ts from "typescript";

import { decorateLanguageService, describeError } from "./plugin";
import type { GemiPluginConfig } from "./types";

/**
 * gemi's TypeScript language service plugin.
 *
 * Enable it in the app's `tsconfig.json`:
 *
 * ```json
 * {
 *   "compilerOptions": {
 *     "plugins": [{ "name": "gemi/ide/typescript-plugin" }]
 *   }
 * }
 * ```
 *
 * VS Code ships its own copy of TypeScript and ignores `plugins` unless told to
 * use the workspace's — run **TypeScript: Select TypeScript Version → Use
 * Workspace Version** once per project. Editors that drive tsserver over LSP
 * (Neovim, Emacs, Helix, JetBrains) read `tsconfig.json` directly and need
 * nothing extra.
 *
 * See `README.md` in this directory for what it does and how it decides.
 *
 * The module's only export is the initializer tsserver calls — `export =` admits
 * no others — so the config shape lives in `./types` as `GemiPluginConfig`.
 */
function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  const tsModule = modules.typescript;

  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      const log = (message: string) => info.project.projectService.logger.info(`[gemi] ${message}`);

      try {
        const config = (info.config ?? {}) as GemiPluginConfig;
        if (config.enable === false) {
          log("disabled by config");
          return info.languageService;
        }

        const projectRoot = trimTrailingSlash(
          config.projectRoot
            ? absolute(config.projectRoot, info.project.getCurrentDirectory())
            : info.project.getCurrentDirectory(),
        );
        const viewsDir = trimTrailingSlash(
          config.viewsDir ? absolute(config.viewsDir, projectRoot) : `${projectRoot}/app/views`,
        );

        log(`activated for ${projectRoot} (views: ${viewsDir})`);

        return decorateLanguageService({
          ts: tsModule,
          languageService: info.languageService,
          projectRoot,
          viewsDir,
          fileExists: (fileName) => info.serverHost.fileExists(fileName),
          getScriptVersion: (fileName) => info.project.getScriptVersion(fileName),
          log,
        });
      } catch (error) {
        // Returning the undecorated service is the difference between "route
        // jumps do not work" and "the editor has no language features".
        log(
          `failed to activate, falling back to the plain language service — ${describeError(error)}`,
        );
        return info.languageService;
      }
    },
  };
}

function absolute(path: string, base: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return normalized;
  return `${trimTrailingSlash(base)}/${normalized.replace(/^\.\//, "")}`;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export = init;
