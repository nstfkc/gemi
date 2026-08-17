import * as tsModule from "typescript";

/**
 * An in-memory TypeScript project, for exercising the plugin the way tsserver
 * does.
 *
 * The plugin's whole job is to answer questions about a `LanguageService`, so
 * the tests give it a real one rather than a stub — the same `getProgram()`, the
 * same checker, the same `getDefinitionAndBoundSpan` underneath. Files live in a
 * map instead of on disk, which keeps the fixtures readable inline and keeps the
 * tests from depending on a template that may or may not be checked out.
 */
export interface TestProject {
  ts: typeof tsModule;
  service: tsModule.LanguageService;
  projectRoot: string;
  fileExists: (fileName: string) => boolean;
  /** Byte offset of `marker` in `fileName`; throws if it is not there or not unique. */
  offsetOf: (fileName: string, marker: string) => number;
  /** `line:column` (1-based) of an offset, for readable assertions. */
  locationOf: (fileName: string, offset: number) => string;
  textAt: (fileName: string, span: tsModule.TextSpan) => string;
  update: (fileName: string, content: string) => void;
  /** The same version token the language service host reports. */
  getScriptVersion: (fileName: string) => string;
}

const PROJECT_ROOT = "/project";

const COMPILER_OPTIONS: tsModule.CompilerOptions = {
  target: tsModule.ScriptTarget.ESNext,
  module: tsModule.ModuleKind.ESNext,
  moduleResolution: tsModule.ModuleResolutionKind.Bundler,
  jsx: tsModule.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  paths: { "@/app/*": ["./app/*"] },
  baseUrl: PROJECT_ROOT,
};

export function createTestProject(
  files: Record<string, string>,
  extraCompilerOptions: tsModule.CompilerOptions = {},
): TestProject {
  const compilerOptions: tsModule.CompilerOptions = {
    ...COMPILER_OPTIONS,
    ...extraCompilerOptions,
    paths: { ...COMPILER_OPTIONS.paths, ...extraCompilerOptions.paths },
  };
  const contents = new Map<string, string>();
  const versions = new Map<string, number>();

  const write = (fileName: string, content: string) => {
    const absolute = fileName.startsWith("/") ? fileName : `${PROJECT_ROOT}/${fileName}`;
    contents.set(absolute, content);
    versions.set(absolute, (versions.get(absolute) ?? 0) + 1);
  };
  for (const [fileName, content] of Object.entries(files)) write(fileName, content);

  const defaultLib = tsModule.getDefaultLibFilePath(compilerOptions);

  const host: tsModule.LanguageServiceHost = {
    getScriptFileNames: () => [...contents.keys()],
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      const content = contents.get(fileName);
      if (content !== undefined) return tsModule.ScriptSnapshot.fromString(content);
      if (!tsModule.sys.fileExists(fileName)) return undefined;
      return tsModule.ScriptSnapshot.fromString(tsModule.sys.readFile(fileName)!);
    },
    getCurrentDirectory: () => PROJECT_ROOT,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: () => defaultLib,
    fileExists: (fileName) => contents.has(fileName) || tsModule.sys.fileExists(fileName),
    readFile: (fileName) => contents.get(fileName) ?? tsModule.sys.readFile(fileName),
    readDirectory: tsModule.sys.readDirectory,
    // Module resolution gives up on a directory it cannot see, and the virtual
    // ones are not on disk — so `./rpc` next to `/project/app.ts` would not
    // resolve without this.
    directoryExists: (directory) =>
      virtualDirectories().has(trimTrailingSlash(directory)) ||
      tsModule.sys.directoryExists(directory),
    getDirectories: (directory) =>
      directory.startsWith(PROJECT_ROOT) ? [] : tsModule.sys.getDirectories(directory),
    realpath: (fileName) => fileName,
  };

  function virtualDirectories(): Set<string> {
    const directories = new Set<string>();
    for (const fileName of contents.keys()) {
      let directory = fileName.slice(0, fileName.lastIndexOf("/"));
      while (directory.startsWith(PROJECT_ROOT)) {
        directories.add(directory);
        directory = directory.slice(0, directory.lastIndexOf("/"));
      }
    }
    return directories;
  }

  function trimTrailingSlash(value: string): string {
    return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  }

  const service = tsModule.createLanguageService(host, tsModule.createDocumentRegistry());

  const contentOf = (fileName: string) => {
    const absolute = fileName.startsWith("/") ? fileName : `${PROJECT_ROOT}/${fileName}`;
    const content = contents.get(absolute);
    if (content === undefined) throw new Error(`no such file in test project: ${absolute}`);
    return content;
  };

  return {
    ts: tsModule,
    service,
    projectRoot: PROJECT_ROOT,
    fileExists: (fileName) => contents.has(fileName),
    offsetOf(fileName, marker) {
      const content = contentOf(fileName);
      const first = content.indexOf(marker);
      if (first === -1) throw new Error(`marker ${JSON.stringify(marker)} not in ${fileName}`);
      if (content.indexOf(marker, first + 1) !== -1) {
        throw new Error(`marker ${JSON.stringify(marker)} is not unique in ${fileName}`);
      }
      return first;
    },
    locationOf(fileName, offset) {
      const content = contentOf(fileName);
      const before = content.slice(0, offset);
      const line = before.split("\n").length;
      const column = offset - (before.lastIndexOf("\n") + 1) + 1;
      return `${line}:${column}`;
    },
    textAt(fileName, span) {
      return contentOf(fileName).slice(span.start, span.start + span.length);
    },
    update: write,
    getScriptVersion: (fileName) => host.getScriptVersion(fileName),
  };
}

/** Absolute path inside the test project, for comparing against tool output. */
export function projectPath(relative: string): string {
  return `${PROJECT_ROOT}/${relative}`;
}
