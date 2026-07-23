import { describe, expect, it, vi } from "vitest";
import { BindingResolutionError, Container } from "./Container";

class Alpha {
  static token = "alpha";
  value = "alpha";
}

class Beta {
  static token = "beta";
  constructor(public alpha: Alpha) {}
}

describe("Container", () => {
  it("resolves a bound factory", () => {
    const container = new Container();
    container.bind(Alpha, () => new Alpha());
    expect(container.make(Alpha)).toBeInstanceOf(Alpha);
  });

  it("returns a new instance per make() for bind()", () => {
    const container = new Container();
    container.bind(Alpha, () => new Alpha());
    expect(container.make(Alpha)).not.toBe(container.make(Alpha));
  });

  it("returns the same instance per make() for singleton()", () => {
    const container = new Container();
    container.singleton(Alpha, () => new Alpha());
    expect(container.make(Alpha)).toBe(container.make(Alpha));
  });

  it("never constructs a singleton that is never resolved", () => {
    const container = new Container();
    const factory = vi.fn(() => new Alpha());
    container.singleton(Alpha, factory);

    expect(container.bound(Alpha)).toBe(true);
    expect(factory).not.toHaveBeenCalled();

    container.make(Alpha);
    expect(factory).toHaveBeenCalledTimes(1);

    container.make(Alpha);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("passes the container to the factory so bindings can compose", () => {
    const container = new Container();
    container.singleton(Alpha, () => new Alpha());
    container.singleton(Beta, (app) => new Beta(app.make(Alpha)));
    expect(container.make(Beta).alpha).toBe(container.make(Alpha));
  });

  it("registers a pre-built object with instance()", () => {
    const container = new Container();
    const alpha = new Alpha();
    expect(container.instance(Alpha, alpha)).toBe(alpha);
    expect(container.make(Alpha)).toBe(alpha);
  });

  it("throws a descriptive BindingResolutionError for unbound tokens", () => {
    const container = new Container();
    container.bind(Alpha, () => new Alpha());
    expect(() => container.make(Beta)).toThrow(BindingResolutionError);
    expect(() => container.make(Beta)).toThrow(/Target \[beta\]/);
    expect(() => container.make(Beta)).toThrow(/alpha/);
  });

  it("reports bound() and resolved() independently", () => {
    const container = new Container();
    container.singleton(Alpha, () => new Alpha());
    expect(container.bound(Alpha)).toBe(true);
    expect(container.resolved(Alpha)).toBe(false);
    container.make(Alpha);
    expect(container.resolved(Alpha)).toBe(true);
  });

  it("drops every binding on flush()", () => {
    const container = new Container();
    container.singleton(Alpha, () => new Alpha());
    container.flush();
    expect(container.bound(Alpha)).toBe(false);
    expect(() => container.make(Alpha)).toThrow(BindingResolutionError);
  });
});
