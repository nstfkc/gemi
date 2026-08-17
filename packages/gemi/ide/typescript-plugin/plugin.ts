import type ts from "typescript";

import type { TS } from "./ast";
import { findRouteQuery } from "./callSite";
import { describeCandidate, describeTarget, lookupRoute, type RouteMatch } from "./lookup";
import { buildRouteTable } from "./routeTable";
import type { RouteTable, RouteTarget, Span, TargetKind } from "./types";

export interface PluginHost {
  ts: TS;
  languageService: ts.LanguageService;
  /** Directory holding the app's `app/` folder. */
  projectRoot: string;
  /** Where `this.view("auth/SignIn")` resolves `auth/SignIn.tsx`. */
  viewsDir: string;
  fileExists(fileName: string): boolean;
  /** Opaque token that changes when a file's contents do. */
  getScriptVersion(fileName: string): string;
  log(message: string): void;
}

/**
 * Wraps a language service so that a route path behaves like a reference to the
 * code that serves it.
 *
 * `useQuery("/reports")` names its handler as precisely as a function call names
 * a function — the string is checked against the router at compile time — but
 * TypeScript has no way to know that, because the connection is made by
 * conditional types rather than by a symbol. So go-to-definition stops at the
 * literal, and reading one call site means opening the router, finding the
 * entry, and following it to the controller by hand.
 *
 * Everything else is delegated untouched. The two methods below answer only when
 * the position really is a route path that really is in the table; in every
 * other case the wrapped service replies, so nothing TypeScript already does
 * well gets worse.
 */
export function decorateLanguageService(host: PluginHost): ts.LanguageService {
  const { ts, languageService } = host;
  const routes = createRouteTableCache(host);

  // Forward every method by hand rather than subclassing or spreading: the
  // interface grows with each TypeScript release, and a proxy built from the
  // instance's own keys picks up whatever this copy actually has.
  const forwarded: Record<string, unknown> = Object.create(null);
  const source = languageService as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const member = source[key];
    if (typeof member !== "function") continue;
    forwarded[key] = (...args: unknown[]) =>
      (member as (...a: unknown[]) => unknown).apply(languageService, args);
  }
  const proxy = forwarded as unknown as ts.LanguageService;

  proxy.getDefinitionAndBoundSpan = (fileName, position) => {
    const matched = match(fileName, position);
    if (!matched) return languageService.getDefinitionAndBoundSpan(fileName, position);

    const definitions = toDefinitions(ts, matched.matches);
    if (definitions.length === 0) {
      return languageService.getDefinitionAndBoundSpan(fileName, position);
    }
    return { textSpan: matched.textSpan, definitions };
  };

  // `getDefinitionAtPosition` is the older entry point; some editors still call
  // it, and Neovim's built-in LSP client reaches it through tsserver's
  // `definition` command. Answering both keeps behaviour identical across them.
  proxy.getDefinitionAtPosition = (fileName, position) => {
    const matched = match(fileName, position);
    if (!matched) return languageService.getDefinitionAtPosition(fileName, position);
    const definitions = toDefinitions(ts, matched.matches);
    return definitions.length > 0
      ? definitions
      : languageService.getDefinitionAtPosition(fileName, position);
  };

  proxy.getQuickInfoAtPosition = (fileName, position) => {
    const original = languageService.getQuickInfoAtPosition(fileName, position);
    const matched = match(fileName, position);
    if (!matched) return original;

    const { heading, documentation } = describeMatches(host, matched.matches);
    // TypeScript has nothing to say about a string literal in argument
    // position, so there is usually no original to preserve — but when there
    // is, it is the parameter's type, which is worth keeping above the route.
    if (original) {
      return {
        ...original,
        documentation: [...(original.documentation ?? []), ...documentation],
      };
    }
    return {
      kind: ts.ScriptElementKind.string,
      kindModifiers: "",
      textSpan: matched.textSpan,
      displayParts: heading,
      documentation,
    };
  };

  return proxy;

  /**
   * Nothing here is allowed to throw. A language service plugin that raises
   * takes the editor's IntelliSense down with it, and a broken jump is a far
   * better failure than a dead language server — so any surprise degrades to
   * "not a route" and the wrapped service answers instead.
   */
  function match(
    fileName: string,
    position: number,
  ): { matches: RouteMatch[]; textSpan: ts.TextSpan } | undefined {
    try {
      const program = languageService.getProgram();
      const sourceFile = program?.getSourceFile(fileName);
      if (!program || !sourceFile) return undefined;

      const query = findRouteQuery(ts, program.getTypeChecker(), sourceFile, position);
      if (!query) return undefined;

      const matches = lookupRoute(routes.get(program), query);
      if (matches.length === 0) return undefined;

      // The span the editor underlines: the path itself, not its quotes.
      const start = query.node.getStart(sourceFile) + 1;
      return { matches, textSpan: { start, length: query.node.text.length } };
    } catch (error) {
      host.log(`route lookup failed at ${fileName}:${position} — ${describeError(error)}`);
      return undefined;
    }
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

function toDefinitions(ts: TS, matches: RouteMatch[]): ts.DefinitionInfo[] {
  const definitions: ts.DefinitionInfo[] = [];
  const seen = new Set<string>();
  for (const { candidate, targets } of matches) {
    for (const target of targets) {
      const key = `${target.fileName}:${target.span.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      definitions.push({
        fileName: target.fileName,
        textSpan: toTextSpan(target.span),
        contextSpan: target.contextSpan ? toTextSpan(target.contextSpan) : undefined,
        kind: scriptElementKind(ts, target.kind),
        name: target.name,
        containerName: target.containerName || describeCandidate(candidate),
        containerKind: ts.ScriptElementKind.unknown,
      });
    }
  }
  return definitions;
}

function describeMatches(
  host: PluginHost,
  matches: RouteMatch[],
): { heading: ts.SymbolDisplayPart[]; documentation: ts.SymbolDisplayPart[] } {
  const lines: string[] = [];
  for (const { candidate, targets } of matches) {
    lines.push(describeCandidate(candidate));
    for (const target of targets) {
      lines.push(`  → ${describeTarget(target)} · ${location(host, target)}`);
    }
  }
  return {
    heading: [
      {
        text: matches.map(({ candidate }) => describeCandidate(candidate)).join(", "),
        kind: "text",
      },
    ],
    documentation: [{ text: lines.join("\n"), kind: "text" }],
  };
}

function location(host: PluginHost, target: RouteTarget): string {
  const relative = target.fileName.startsWith(`${host.projectRoot}/`)
    ? target.fileName.slice(host.projectRoot.length + 1)
    : target.fileName;
  const sourceFile = host.languageService.getProgram()?.getSourceFile(target.fileName);
  if (!sourceFile) return relative;
  const { line } = sourceFile.getLineAndCharacterOfPosition(target.span.start);
  return `${relative}:${line + 1}`;
}

function toTextSpan(span: Span): ts.TextSpan {
  return { start: span.start, length: span.length };
}

function scriptElementKind(ts: TS, kind: TargetKind): ts.ScriptElementKind {
  switch (kind) {
    case "controller-method":
      return ts.ScriptElementKind.memberFunctionElement;
    case "inline-handler":
      return ts.ScriptElementKind.functionElement;
    case "view-component":
      return ts.ScriptElementKind.functionElement;
    case "route-entry":
      return ts.ScriptElementKind.memberVariableElement;
  }
}

interface RouteTableCache {
  get(program: ts.Program): RouteTable;
}

/**
 * Keeps the route table across edits that cannot have changed it.
 *
 * A definition request arrives on a keystroke, and the program object is new
 * every time — so program identity alone would mean rebuilding the table on
 * every character typed anywhere in the project. The table records which files
 * it was derived from, and those are re-read only when one of their versions
 * moves. The file count is part of the key too, because a route can also appear
 * by a file being created, which no existing version reflects.
 */
function createRouteTableCache(host: PluginHost): RouteTableCache {
  let cached: { table: RouteTable; versions: Map<string, string>; fileCount: number } | undefined;

  return {
    get(program) {
      const fileCount = program.getSourceFiles().length;
      if (cached && cached.fileCount === fileCount && isUnchanged(cached.versions)) {
        return cached.table;
      }

      const started = Date.now();
      const table = buildRouteTable(host.ts, program, {
        projectRoot: host.projectRoot,
        viewsDir: host.viewsDir,
        fileExists: host.fileExists,
      });
      const versions = new Map<string, string>();
      for (const fileName of table.dependencies) {
        versions.set(fileName, host.getScriptVersion(fileName));
      }
      cached = { table, versions, fileCount };

      host.log(
        `built route table in ${Date.now() - started}ms: ${table.api.size} api paths, ` +
          `${table.views.size} view paths, from ${table.dependencies.length} files`,
      );
      for (const diagnostic of table.diagnostics) host.log(diagnostic);
      return table;
    },
  };

  function isUnchanged(versions: Map<string, string>): boolean {
    for (const [fileName, version] of versions) {
      if (host.getScriptVersion(fileName) !== version) return false;
    }
    return true;
  }
}
