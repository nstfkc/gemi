// Imported from vitest, not `bun:test`. This file was written against the bun
// runner while the suite runs under vitest, so vitest failed to *collect* it —
// "Cannot use describe outside of the test runner" — and it counted as one
// failing file with zero tests run. CI excluded it on that basis (#163),
// alongside genuinely dead code, which hid the more useful fact: none of these
// 28 assertions had ever executed here, and `parseTranslation` is live —
// `i18n/Dictionary.ts` and `client/useTranslator.ts` both call it.
import { test, expect, describe } from "vitest";
import type { ReactElement } from "react";
import { parseTranslation } from "./parseTranslation";
import { renderToString } from "react-dom/server";

// Helper function to compare JSX output
function jsxToString(jsx: ReactElement): string {
  return (
    renderToString(jsx)
      .replace(/data-reactroot=""/g, "")
      // React emits `<!-- -->` between *adjacent text nodes* so hydration can
      // tell where one ends and the next begins. `parseTranslation` produces
      // exactly that shape — a Fragment of alternating strings and elements —
      // so the separators appear around every interpolated variable. They are
      // not part of the rendered text and no assertion here is about them.
      .replace(/<!-- -->/g, "")
      .trim()
  );
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
    /**
     * A function that always returns JSX does **not** throw — it is the whole
     * feature. `parseTranslation` probes every function param with `""` up
     * front, so this one is detected and the JSX branch handles it.
     *
     * This assertion previously expected a throw here and could never have
     * passed. It never ran: the file imported `bun:test` while the suite runs
     * under vitest, so it failed to collect and CI excluded it (#163).
     */
    test("a JSX-returning param takes the JSX branch rather than throwing", () => {
      const result = parseTranslation("{{link:[click]}}", {
        link: (text: string) => <a href="/test">{text}</a>,
      });

      expect(jsxToString(result)).toBe('<a href="/test">click</a>');
    });

    /**
     * The guard *is* reachable, by a function whose return type depends on its
     * argument: the `""` probe sees a string, so the string branch is chosen,
     * and then the real call returns an element into a context that can only
     * concatenate strings. Throwing beats `String(element)` — which is
     * `"[object Object]"` in the middle of a sentence.
     */
    test("JSX returned in string context throws", () => {
      expect(() => {
        parseTranslation("{{link:[click]}}", {
          link: (text: string) =>
            text ? <a href="/test">{text}</a> : "",
        });
      }).toThrow("JSX returned in string context");
    });
  });
});
