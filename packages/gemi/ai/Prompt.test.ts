import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Prompt } from "./Prompt";

let dir: string;

function write(file: string, text: string) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gemi-prompt-"));
  Prompt.configure({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  Prompt.configure({});
  vi.unstubAllEnvs();
});

describe("Prompt.render", () => {
  test("fills placeholders and drops the final newline", () => {
    write("siteNamer/name.md", "Name a site for {{business}} in {{count}} words.\n");
    expect(Prompt.render("siteNamer/name", { business: "a bakery", count: 3 })).toBe(
      "Name a site for a bakery in 3 words.",
    );
  });

  test("a bare name is a shared prompt", () => {
    write("prompts/copy-guide.md", "Write plainly.");
    expect(Prompt.render("copy-guide")).toBe("Write plainly.");
  });

  test("the shared folder is configurable", () => {
    Prompt.configure({ dir, shared: "common" });
    write("common/tone.md", "Warm.");
    expect(Prompt.render("tone")).toBe("Warm.");
  });

  test("a relative dir resolves from the working directory", () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    Prompt.configure({ dir: "app/agents" });
    write("app/agents/prompts/hello.md", "Hello {{name}}");
    expect(Prompt.render("hello", { name: "Ada" })).toBe("Hello Ada");
    vi.restoreAllMocks();
  });

  test("throws on a placeholder without a value", () => {
    write("prompts/p.md", "Hi {{name}}, {{other}}");
    expect(() => Prompt.render("p", { name: "Ada" })).toThrow(
      'The prompt "p" has no value for {{other}}.',
    );
  });

  test("a value named like an Object.prototype key is not a value", () => {
    write("prompts/p.md", "{{constructor}}");
    expect(() => Prompt.render("p")).toThrow("no value for {{constructor}}");
  });

  test("ignores values no placeholder uses", () => {
    write("prompts/p.md", "Hi {{name}}");
    expect(Prompt.render("p", { name: "Ada", unused: "x" })).toBe("Hi Ada");
  });

  test("throws on a missing file", () => {
    expect(() => Prompt.render("nope/missing")).toThrow('The prompt "nope/missing" does not exist');
  });

  test("rejects names that leave the prompt folder", () => {
    expect(() => Prompt.render("../secrets")).toThrow("is not a prompt name");
    expect(() => Prompt.render("/etc/passwd")).toThrow("is not a prompt name");
  });

  test("leaves braces that are not placeholders alone", () => {
    write("prompts/p.md", "style={{ color: x }} and {{ spaced }} and {{name}}");
    expect(Prompt.render("p", { name: "n" })).toBe("style={{ color: x }} and {{ spaced }} and n");
  });

  test("does not re-scan values", () => {
    write("prompts/p.md", "{{a}} {{b}}");
    expect(Prompt.render("p", { a: "{{b}}", b: "{{> x}}" })).toBe("{{b}} {{> x}}");
  });
});

describe("partials", () => {
  test("includes a partial, which shares the values", () => {
    write("prompts/credit-prices.md", "A page costs {{price}} credits.\n");
    write("builder/system.md", "Build {{what}}.\n{{> credit-prices}}\nDone.");
    expect(Prompt.render("builder/system", { what: "a page", price: 5 })).toBe(
      "Build a page.\nA page costs 5 credits.\nDone.",
    );
  });

  test("partials nest and resolve by the same rules", () => {
    write("shared/a.md", "A({{> shared/b}})");
    write("shared/b.md", "B({{> c}})");
    write("prompts/c.md", "C");
    expect(Prompt.render("shared/a")).toBe("A(B(C))");
  });

  test("throws on a cycle", () => {
    write("prompts/a.md", "{{> b}}");
    write("prompts/b.md", "{{> a}}");
    expect(() => Prompt.render("a")).toThrow('The prompt "a" includes itself: a > b > a.');
  });

  test("throws on a missing partial", () => {
    write("prompts/a.md", "{{> gone}}");
    expect(() => Prompt.render("a")).toThrow('The prompt "gone" does not exist');
  });
});

describe("Prompt.placeholders", () => {
  test("lists the placeholders once, partials included", () => {
    write("prompts/p.md", "{{a}} {{b}} {{a}} {{> q}}");
    write("prompts/q.md", "{{c}} {{b}}");
    expect(Prompt.placeholders("p")).toEqual(["a", "b", "c"]);
  });
});

describe("caching", () => {
  test("re-reads an edited file outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    write("prompts/p.md", "one");
    expect(Prompt.render("p")).toBe("one");
    write("prompts/p.md", "two");
    expect(Prompt.render("p")).toBe("two");
  });

  test("keeps the first read in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    write("prompts/p.md", "one");
    expect(Prompt.render("p")).toBe("one");
    write("prompts/p.md", "two");
    expect(Prompt.render("p")).toBe("one");
  });

  test("cache: false turns it off in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    Prompt.configure({ dir, cache: false });
    write("prompts/p.md", "one");
    Prompt.render("p");
    write("prompts/p.md", "two");
    expect(Prompt.render("p")).toBe("two");
  });
});
