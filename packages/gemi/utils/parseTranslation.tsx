import { createElement, Fragment, isValidElement, type JSX } from "react";

type TemplateParams = Record<
  string,
  string | ((p: unknown) => string | JSX.Element)
>;

export function parseTranslation(template: string, params: TemplateParams) {
  // Check if we have any JSX in our parameters
  const hasJSX = Object.values(params).some(
    (value) =>
      typeof value === "function" &&
      isValidElement((value as (p: unknown) => unknown)("")),
  );

  // Regular expression to match template variables:
  // {{name}} - simple variable
  // {{name:type}} - variable with type casting
  // {{name:[content]}} - variable with interpolated content
  const regex = /{{([^{}]+?)(?::([^{}\[\]]+?))?(?:\[(.*?)\])?}}/g;

  if (!hasJSX) {
    // Simple string replacement
    const result = template.replace(regex, (match, name, type, content) => {
      // Clean the name part by removing any colon if present
      const cleanName = name.includes(":") ? name.split(":")[0] : name;

      const value = params[cleanName];
      if (value === undefined) {
        return match; // Return original match if no parameter found
      }

      if (typeof value === "function") {
        // If value is a function, call it with the content if available
        const functionParam = content !== undefined ? content : "";
        const functionResult = value(functionParam);
        // Check if function returned JSX - this shouldn't happen in the string branch
        if (isValidElement(functionResult)) {
          throw new Error("JSX returned in string context");
        }
        return String(functionResult);
      }

      // Handle type casting if specified
      if (type) {
        switch (type.toLowerCase()) {
          case "number":
            return Number(value).toString();
          case "string":
            return String(value);
          case "boolean":
            return Boolean(value).toString();
          default:
            return String(value);
        }
      }
      return String(value);
    });
    return result as any;
  } else {
    // JSX replacement - we'll split the template into parts
    const parts: Array<string | JSX.Element> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null = null;

    while ((match = regex.exec(template)) !== null) {
      const [fullMatch, name, type, content] = match;
      const matchIndex = match.index;

      // Clean the name part by removing any colon if present
      const cleanName = name.includes(":") ? name.split(":")[0] : name;

      // Add text before the match
      if (matchIndex > lastIndex) {
        parts.push(template.substring(lastIndex, matchIndex));
      }

      const value = params[cleanName];
      if (value === undefined) {
        // Keep original template variable if no parameter found
        parts.push(fullMatch);
      } else if (typeof value === "function") {
        // If value is a function, call it with the content if available
        const functionParam = content !== undefined ? content : "";
        const functionResult = value(functionParam);
        parts.push(functionResult);
      } else if (type) {
        // Handle type casting if specified
        switch (type.toLowerCase()) {
          case "number":
            parts.push(Number(value).toString());
            break;
          case "string":
            parts.push(String(value));
            break;
          case "boolean":
            parts.push(Boolean(value).toString());
            break;
          default:
            parts.push(String(value));
        }
      } else {
        parts.push(String(value));
      }

      lastIndex = matchIndex + fullMatch.length;
    }

    // Add any remaining text
    if (lastIndex < template.length) {
      parts.push(template.substring(lastIndex));
    }

    // Convert the parts array to JSX
    return createElement(Fragment, {}, ...parts) as any;
  }
}
