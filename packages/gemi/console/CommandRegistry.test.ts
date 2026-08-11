import { describe, expect, test } from "vitest";

import { Command } from "./Command";
import { CommandRegistry } from "./CommandRegistry";
import { defineCommand } from "./builder";

/**
 * The rules about what a command may be, and the seam a test asks "what did you
 * actually take".
 *
 * The interesting decision recorded here is the duplicate-name one. `QueueManager
 * .useJobs` and `Scheduler.start` both keep the first of two same-named classes
 * and warn, because a server has to boot: running one of two identically-named
 * jobs beats refusing to start. This refuses outright, because a CLI has no boot
 * to protect and a person is waiting — running the wrong one of two commands
 * called `db:seed` is strictly worse than running neither and being told why.
 */

const command = (name: string, description = "") =>
  defineCommand(name)
    .describe(description)
    .handle(() => {});

describe("what the registry took", () => {
  test("is readable, and in declaration order", () => {
    const registry = new CommandRegistry([
      command("db:seed"),
      command("send-digest"),
    ]);

    expect(registry.commands.map((entry) => entry.commandName)).toEqual([
      "db:seed",
      "send-digest",
    ]);
  });

  test("looks up by the exact name, and misses cleanly", () => {
    const registry = new CommandRegistry([command("db:seed")]);

    expect(registry.get("db:seed")?.commandName).toBe("db:seed");
    expect(registry.get("db:sed")).toBeUndefined();
  });

  test("an application with no commands is an ordinary state", () => {
    expect(new CommandRegistry([]).commands).toEqual([]);
  });
});

describe("commands that cannot be run", () => {
  test("a class that never declared a name is refused, with the fix", () => {
    class Nameless extends Command {}

    expect(() => new CommandRegistry([Nameless])).toThrow(
      /does not declare a command name/,
    );
    expect(() => new CommandRegistry([Nameless])).toThrow(/defineCommand/);
  });

  test("the refusal names the offending class", () => {
    class Nameless extends Command {}

    expect(() => new CommandRegistry([Nameless])).toThrow(/`Nameless`/);
  });

  /**
   * The concrete payoff of keeping the name off `static name`. `Job` shadows
   * `Function.name` to key its registry, which is right there; here it would
   * cost this message the only two facts it has to convey.
   */
  test("two commands with one name are refused, naming both classes", () => {
    const first = command("db:seed");
    const second = command("db:seed");
    Object.defineProperty(first, "name", { value: "SeedDatabase" });
    Object.defineProperty(second, "name", { value: "SeedTenants" });

    expect(() => new CommandRegistry([first, second])).toThrow(
      /Two commands are named "db:seed"/,
    );
    expect(() => new CommandRegistry([first, second])).toThrow(/SeedDatabase/);
    expect(() => new CommandRegistry([first, second])).toThrow(/SeedTenants/);
  });
});

describe("suggesting a near miss", () => {
  const registry = () =>
    new CommandRegistry([
      command("db:seed"),
      command("db:reset"),
      command("send-digest"),
    ]);

  test("a typo finds the name it meant", () => {
    expect(registry().suggest("db:sed")).toContain("db:seed");
    expect(registry().suggest("send-digset")).toContain("send-digest");
  });

  test("a prefix finds what it starts", () => {
    expect(registry().suggest("send")).toEqual(["send-digest"]);
  });

  /**
   * A typo inside the namespace is the common case, and the useful answer is
   * every command in that namespace rather than the nearest single string.
   */
  test("a wrong name in a right namespace finds the namespace", () => {
    expect(registry().suggest("db:truncate").sort()).toEqual([
      "db:reset",
      "db:seed",
    ]);
  });

  test("something unrelated suggests nothing rather than reaching", () => {
    expect(registry().suggest("completely-different")).toEqual([]);
  });

  test("at most three, so the message stays a message", () => {
    const many = new CommandRegistry(
      ["a:one", "a:two", "a:three", "a:four", "a:five"].map((name) =>
        command(name),
      ),
    );

    expect(many.suggest("a:six").length).toBeLessThanOrEqual(3);
  });
});
