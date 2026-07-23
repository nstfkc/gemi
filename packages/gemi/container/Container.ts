/**
 * Tokens are the service classes themselves, so `make(MailManager)` is typed
 * `MailManager` without a cast. The container keys its bindings off the class's
 * `static token` string rather than the constructor object: the built binary
 * (`dist/bin/gemi.js`) bundles its own copy of gemi while the app resolves
 * `gemi/*` to source, so the same service is two distinct class objects across
 * that boundary. A string survives it. Laravel binds both `'mail'` and
 * `MailManager::class` for the same reason.
 */
export type ServiceToken<T> = (abstract new (...args: any[]) => T) & {
  token: string;
};

export type Factory<T> = (app: Container) => T;

interface Binding {
  factory: Factory<any>;
  shared: boolean;
}

export class BindingResolutionError extends Error {
  constructor(token: string, known: string[]) {
    super(
      `Target [${token}] is not bound in the container.` +
        (known.length > 0
          ? ` Bound tokens: ${known.join(", ")}.`
          : " No tokens are bound — was the application booted?"),
    );
    this.name = "BindingResolutionError";
  }
}

export class Container {
  private bindings = new Map<string, Binding>();
  private instances = new Map<string, any>();

  bind<T>(token: ServiceToken<T>, factory: Factory<T>) {
    this.bindings.set(token.token, { factory, shared: false });
    this.instances.delete(token.token);
  }

  /**
   * Lazy by design — `factory` is not called until the first `make()`.
   */
  singleton<T>(token: ServiceToken<T>, factory: Factory<T>) {
    this.bindings.set(token.token, { factory, shared: true });
    this.instances.delete(token.token);
  }

  instance<T>(token: ServiceToken<T>, object: T): T {
    this.instances.set(token.token, object);
    return object;
  }

  bound<T>(token: ServiceToken<T>): boolean {
    return (
      this.bindings.has(token.token) || this.instances.has(token.token)
    );
  }

  resolved<T>(token: ServiceToken<T>): boolean {
    return this.instances.has(token.token);
  }

  make<T>(token: ServiceToken<T>): T {
    const key = token.token;

    if (this.instances.has(key)) {
      return this.instances.get(key) as T;
    }

    const binding = this.bindings.get(key);
    if (!binding) {
      throw new BindingResolutionError(key, this.keys());
    }

    const object = binding.factory(this) as T;
    if (binding.shared) {
      this.instances.set(key, object);
    }
    return object;
  }

  forget<T>(token: ServiceToken<T>) {
    this.instances.delete(token.token);
  }

  keys(): string[] {
    return [
      ...new Set([...this.bindings.keys(), ...this.instances.keys()]),
    ];
  }

  flush() {
    this.bindings.clear();
    this.instances.clear();
  }
}
