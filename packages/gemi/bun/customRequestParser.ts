import { parse, print } from "recast";
import { builders } from "ast-types";

export async function customRequestParser(original: string) {
  // Every identifier we turn from a type annotation into a `new X()` default
  // value. Their imports have to survive as value imports.
  const promotedToValue = new Set<string>();

  function isExportedControllerClassDeclaration(body: any) {
    return (
      (body.type === "ExportNamedDeclaration" ||
        body.type === "ExportDefaultDeclaration") &&
      body.declaration?.type === "ClassDeclaration" &&
      (body.declaration.superClass?.name === "Controller" ||
        body.declaration.superClass?.name === "ResourceController")
    );
  }

  function isController(body: any) {
    return (
      body.type === "ClassDeclaration" &&
      (body.superClass?.name === "Controller" ||
        body.superClass?.name === "ResourceController")
    );
  }

  function isRouterClassDeclaration(body: any) {
    return (
      body.type === "ClassDeclaration" &&
      (body.superClass?.name === "ApiRouter" ||
        body.superClass?.name === "ViewRouter")
    );
  }

  function isRouterExportedClassDeclaration(body: any) {
    return (
      (body.type === "ExportNamedDeclaration" ||
        body.type === "ExportDefaultDeclaration") &&
      body.declaration?.type === "ClassDeclaration" &&
      (body.declaration.superClass?.name === "ApiRouter" ||
        body.declaration.superClass?.name === "ViewRouter")
    );
  }

  function controllerBodyParser(body: any) {
    for (const node of body.body) {
      if (node.type === "ClassMethod") {
        if (node.params.length === 0) {
          continue;
        }
        if (
          node.accessibility === "private" ||
          node.accessibility === "protected"
        ) {
          continue;
        }

        const paramName = node.params[0].name;
        let reqName = "";
        try {
          reqName = node.params[0].typeAnnotation.typeAnnotation.typeName.name;
        } catch (err) {
          // Do something
        }
        if (reqName === "") {
          continue;
        }

        const left = builders.identifier(paramName);
        const right = builders.newExpression(builders.identifier(reqName), []);
        const _node = builders.assignmentPattern(left, right);
        node.params[0] = _node;
        promotedToValue.add(reqName);
      }
    }
  }

  function apiRouterParser(body: any) {
    for (const node of body) {
      if (
        node.key.name === "routes" &&
        node.value.type === "ObjectExpression"
      ) {
        for (const property of node.value.properties) {
          if (property?.value?.type === "Identifier") {
            continue;
          }

          const args =
            property?.value?.callee?.object?.arguments ??
            property?.value?.arguments;

          for (const arg of args ?? []) {
            if (
              !(
                arg.type === "ArrowFunctionExpression" ||
                arg.type === "FunctionExpression"
              )
            ) {
              continue;
            }

            const [param] = arg.params;

            if (!param) {
              continue;
            }

            let reqName = "";
            try {
              reqName = param.typeAnnotation.typeAnnotation.typeName.name;
            } catch (err) {
              // Do something
            }
            if (reqName === "") {
              continue;
            }
            const name = param.name;
            const left = builders.identifier(name);
            const right = builders.newExpression(
              builders.identifier(reqName),
              [],
            );
            const _node = builders.assignmentPattern(left, right);
            arg.params[0] = _node;
            promotedToValue.add(reqName);
          }
        }
      }
    }
  }

  // A param annotated as `req: HttpRequest` becomes `req = new HttpRequest()`,
  // so a type-only import of it would be stripped by the transpiler and leave a
  // dangling reference. Turn those imports into value imports.
  function promoteTypeOnlyImports(body: any[]) {
    for (const node of body) {
      if (node?.type !== "ImportDeclaration") {
        continue;
      }

      const specifiers = node.specifiers ?? [];
      const isNeeded = (specifier: any) =>
        promotedToValue.has(specifier.local?.name ?? specifier.imported?.name);

      if (node.importKind === "type") {
        if (!specifiers.some(isNeeded)) {
          continue;
        }
        // `import type { A, B }` -> `import { A, type B }`, keeping the
        // untouched specifiers type-only.
        node.importKind = "value";
        for (const specifier of specifiers) {
          if (!isNeeded(specifier)) {
            specifier.importKind = "type";
          }
        }
        continue;
      }

      for (const specifier of specifiers) {
        if (specifier.importKind === "type" && isNeeded(specifier)) {
          specifier.importKind = "value";
        }
      }
    }
  }

  const orgFile = await parse(original, {
    parser: await import("recast/parsers/typescript"),
  });

  for (const body of orgFile.program.body) {
    if (!body || body?.type === "ImportDeclaration") {
      continue;
    }

    if (isExportedControllerClassDeclaration(body)) {
      controllerBodyParser(body.declaration.body);
      continue;
    }

    if (isController(body)) {
      controllerBodyParser(body.body);
      continue;
    }

    if (isRouterClassDeclaration(body)) {
      apiRouterParser(body.body.body);
      continue;
    }

    if (isRouterExportedClassDeclaration(body)) {
      apiRouterParser(body.declaration.body.body);
      continue;
    }
  }
  promoteTypeOnlyImports(orgFile.program.body);

  return print(orgFile).code;
}
