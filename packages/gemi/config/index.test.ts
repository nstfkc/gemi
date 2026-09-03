import { afterEach, describe, expect, test } from "vitest";

import { defineConfig, reactCompiler } from "./index";

/**
 * `reactCompiler()` — the environment switch in front of the React Compiler.
 *
 * The default is the assertion that matters most. This value is read while
 * `gemi.config.ts` is loaded, in the Vite process `dev` and `build` spawn, and a
 * variable that is unset there must not read as "off" — that would silently ship
 * an unoptimized client build to anyone whose environment did not mention the
 * flag, which is everyone.
 */

const original = process.env.GEMI_REACT_COMPILER;

afterEach(() => {
  if (original === undefined) delete process.env.GEMI_REACT_COMPILER;
  else process.env.GEMI_REACT_COMPILER = original;
});

describe("reactCompiler", () => {
  test("is on when the variable is unset", () => {
    delete process.env.GEMI_REACT_COMPILER;
    expect(reactCompiler()).toBe(true);
  });

  test("is off for `off`, case-insensitively", () => {
    for (const value of ["off", "OFF", "Off"]) {
      process.env.GEMI_REACT_COMPILER = value;
      expect(reactCompiler(), value).toBe(false);
    }
  });

  test("stays on for every other value", () => {
    // Deliberately a named opt-out rather than a boolean: `0`, `false` and `no`
    // all read as "off" to a human, and treating one of them as the magic word
    // would leave the other two silently enabling what the user meant to
    // disable. One spelling, and it is the documented one.
    for (const value of ["", "on", "auto", "1", "0", "false", "no", "true"]) {
      process.env.GEMI_REACT_COMPILER = value;
      expect(reactCompiler(), JSON.stringify(value)).toBe(true);
    }
  });

  test("passes compiler options through when on", () => {
    delete process.env.GEMI_REACT_COMPILER;
    const options = { compilationMode: "annotation" } as const;
    expect(reactCompiler(options)).toBe(options);
  });

  test("returns false in place of options when off", () => {
    // `compiler` is `boolean | Options`, so `false` is the disabled value
    // whether or not options were supplied — the switch has to win over them.
    process.env.GEMI_REACT_COMPILER = "off";
    expect(reactCompiler({ compilationMode: "annotation" })).toBe(false);
  });

  test("is read at call time, not at import time", () => {
    // The config module may be imported before the process that spawns Vite has
    // finished assembling its environment; reading at module scope would freeze
    // whatever was set first.
    process.env.GEMI_REACT_COMPILER = "off";
    expect(reactCompiler()).toBe(false);
    process.env.GEMI_REACT_COMPILER = "on";
    expect(reactCompiler()).toBe(true);
  });
});

describe("defineConfig", () => {
  test("returns the config it is given", () => {
    const config = { vite: { plugins: [] } };
    expect(defineConfig(config)).toBe(config);
  });
});
