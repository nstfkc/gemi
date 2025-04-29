import { test, expect, describe } from "bun:test";
import type { ReactElement } from "react";
import { parseTranslation } from "./parseTranslation"; // Adjust path as needed
import { renderToString } from "react-dom/server";

// Helper function to compare JSX output
function jsxToString(jsx: ReactElement): string {
  return renderToString(jsx)
    .replace(/data-reactroot=""/g, "")
    .trim();
}

describe("parseTranslation function", () => {
  describe("String output", () => {
    test("basic variable replacement", () => {
      const result = parseTranslation("Hello {{name}}!", { name: "John" });
      expect(result).toBe("Hello John!");
    });

    test("multiple variables", () => {
      const result = parseTranslation("{{greeting}} {{name}}!", {
        greeting: "Hello",
        name: "John",
      });
      expect(result).toBe("Hello John!");
    });

    test("typed variables", () => {
      const result = parseTranslation("You are {{age:number}} years old", {
        age: "25",
      });
      expect(result).toBe("You are 25 years old");
    });

    test("function variables returning strings", () => {
      const result = parseTranslation("Hello {{name}}!", {
        name: () => "John",
      });
      expect(result).toBe("Hello John!");
    });

    test("interpolation with function returning string", () => {
      const result = parseTranslation("I {{like:[really enjoy]}} coding", {
        like: (text: string) => text.toUpperCase(),
      });
      expect(result).toBe("I REALLY ENJOY coding");
    });

    test("missing variables remain as template", () => {
      const result = parseTranslation("Hello {{name}}!", {});
      expect(result).toBe("Hello {{name}}!");
    });

    test("mix of defined and undefined variables", () => {
      const result = parseTranslation("{{greeting}} {{name}}!", {
        greeting: "Hello",
      });
      expect(result).toBe("Hello {{name}}!");
    });

    test("type casting to number", () => {
      const result = parseTranslation("Total: {{amount:number}}", {
        amount: "123.45",
      });
      expect(result).toBe("Total: 123.45");
    });

    test("type casting to boolean", () => {
      const result = parseTranslation("Is valid: {{valid:boolean}}", {
        valid: "1",
      });
      expect(result).toBe("Is valid: true");
    });

    test("type casting with invalid type defaults to string", () => {
      const result = parseTranslation("Value: {{val:invalid}}", { val: "123" });
      expect(result).toBe("Value: 123");
    });

    test("handles non-string inputs correctly", () => {
      const result = parseTranslation("Count: {{count}}", { count: "42" });
      expect(result).toBe("Count: 42");
    });
  });

  describe("JSX output", () => {
    test("function returning JSX", () => {
      const result = parseTranslation("Click {{link:[here]}}!", {
        link: (text: string) => <a href="/link">{text}</a>,
      });

      expect(jsxToString(result)).toBe('Click <a href="/link">here</a>!');
    });

    test("multiple JSX elements", () => {
      const result = parseTranslation(
        "{{bold:[Important]}} {{link:[click here]}}",
        {
          bold: (text: string) => <strong>{text}</strong>,
          link: (text: string) => <a href="/link">{text}</a>,
        },
      );

      expect(jsxToString(result)).toBe(
        '<strong>Important</strong> <a href="/link">click here</a>',
      );
    });

    test("mix of text, variables and JSX", () => {
      const result = parseTranslation(
        "Hello {{name}}, please {{terms:[accept our terms]}}",
        {
          name: "John",
          terms: (text: string) => <a href="/terms">{text}</a>,
        },
      );

      expect(jsxToString(result)).toBe(
        'Hello John, please <a href="/terms">accept our terms</a>',
      );
    });

    test("JSX with non-JSX variables", () => {
      const result = parseTranslation("User: {{name}}, Age: {{age:number}}", {
        name: "John",
        age: "25",
      });

      expect(jsxToString(result)).toBe("User: John, Age: 25");
    });

    test("missing variables in JSX context", () => {
      const result = parseTranslation("Hello {{name}}, click {{link:[here]}}", {
        link: (text: string) => <a href="/link">{text}</a>,
      });

      expect(jsxToString(result)).toBe(
        'Hello {{name}}, click <a href="/link">here</a>',
      );
    });
  });

  describe("Edge cases", () => {
    test("empty template", () => {
      const result = parseTranslation("", { name: "John" });
      expect(result).toBe("");
    });

    test("template with no variables", () => {
      const result = parseTranslation("Hello world!", { name: "John" });
      expect(result).toBe("Hello world!");
    });

    test("empty parameters", () => {
      const result = parseTranslation("Hello {{name}}!", {});
      expect(result).toBe("Hello {{name}}!");
    });

    test("template with malformed variables", () => {
      const result = parseTranslation("Hello {name}! {{greeting}", {
        name: "John",
        greeting: "Hi",
      });
      expect(result).toBe("Hello {name}! {{greeting}");
    });

    test("nested braces", () => {
      const result = parseTranslation("{{obj:[{id: 1}]}}", {
        obj: (text: string) => `Object: ${text}`,
      });
      expect(result).toBe("Object: {id: 1}");
    });

    test("function throwing error", () => {
      expect(() => {
        parseTranslation("{{error:[test]}}", {
          error: () => {
            throw new Error("Test error");
          },
        });
      }).toThrow();
    });
  });

  describe("Error handling", () => {
    test("JSX in string context should throw error", () => {
      expect(() => {
        // @ts-ignore - Deliberately testing runtime behavior with incorrect types
        parseTranslation("{{link:[click]}}", {
          link: (text: string) => <a href="/test">{text}</a>,
        });
      }).toThrow("JSX returned in string context");
    });
  });
});
