import { parse, print } from "recast";
import { builders } from "ast-types";

export async function customRequestParser(original: string) {
  function isExportedControllerClassDeclaration(body: any) {
    return (
      body.type === "ExportNamedDeclaration" &&
      body.declaration.type === "ClassDeclaration" &&
      body.declaration.superClass.name === "Controller"
    );
  }

  function isController(body: any) {
    return (
      body.type === "ClassDeclaration" && body.superClass.name === "Controller"
    );
  }

  function isRouterClassDeclaration(body: any) {
    return (
      body.type === "ClassDeclaration" &&
      (body.superClass.name === "ApiRouter" ||
        body.superClass.name === "ViewRouter")
    );
  }

  function isRouterExportedClassDeclaration(body: any) {
    return (
      body.type === "ExportNamedDeclaration" &&
      body.declaration.type === "ClassDeclaration" &&
      (body.declaration.superClass.name === "ApiRouter" ||
        body.declaration.superClass.name === "ViewRouter")
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
          for (const arg of property.value?.arguments) {
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
          }
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
  return print(orgFile).code;
}
