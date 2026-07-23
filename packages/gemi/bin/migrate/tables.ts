// The 0.42 -> 0.50 rename tables the codemod drives off. Keeping them as data
// (rather than scattered string literals) means `UPGRADE.md` and the codemod
// cannot drift apart.

export interface ProviderMigration {
  /** Base class the app's provider extended in 0.42. */
  provider: string;
  /** Top-level key in the config Repository, and the `app/config/*.ts` name. */
  configKey: string;
  /** Nested key when two providers collapse into one slice (`route`). */
  section?: string;
  defineFn: string;
  /** Module the `define*` helper is imported from. */
  defineModule: string;
  /** Provider members renamed on the way to config. */
  memberRenames?: Record<string, string>;
}

export const PROVIDER_MIGRATIONS: ProviderMigration[] = [
  {
    provider: "AuthenticationServiceProvider",
    configKey: "auth",
    defineFn: "defineAuthConfig",
    defineModule: "gemi/services",
    memberRenames: { adapter: "userProvider" },
  },
  {
    provider: "EmailServiceProvider",
    configKey: "mail",
    defineFn: "defineMailConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "LoggingServiceProvider",
    configKey: "log",
    defineFn: "defineLogConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "FileStorageServiceProvider",
    configKey: "filesystem",
    defineFn: "defineFilesystemConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "QueueServiceProvider",
    configKey: "queue",
    defineFn: "defineQueueConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "RedisServiceProvider",
    configKey: "redis",
    defineFn: "defineRedisConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "BroadcastingServiceProvider",
    configKey: "broadcast",
    defineFn: "defineBroadcastConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "ImageOptimizationServiceProvider",
    configKey: "image",
    defineFn: "defineImageConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "RateLimiterServiceProvider",
    configKey: "ratelimiter",
    defineFn: "defineRateLimiterConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "CronServiceProvider",
    configKey: "schedule",
    defineFn: "defineScheduleConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "I18nServiceProvider",
    configKey: "translation",
    defineFn: "defineTranslationConfig",
    defineModule: "gemi/i18n",
  },
  {
    provider: "MiddlewareServiceProvider",
    configKey: "middleware",
    defineFn: "defineMiddlewareConfig",
    defineModule: "gemi/http",
  },
  {
    provider: "ApiRouterServiceProvider",
    configKey: "route",
    section: "api",
    defineFn: "defineRouteConfig",
    defineModule: "gemi/services",
  },
  {
    provider: "ViewRouterServiceProvider",
    configKey: "route",
    section: "view",
    defineFn: "defineRouteConfig",
    defineModule: "gemi/services",
  },
];

/** Order the `route` slice's sections are emitted in. */
export const SECTION_ORDER = ["api", "view"];

/** Facade renames — the only two identifiers an app has to change. */
export const FACADE_RENAMES: Record<string, string> = {
  FileStorage: "Storage",
  I18n: "Lang",
};

/**
 * `*ServiceContainer` -> manager. Apps rarely referenced these directly, but a
 * `SomethingServiceContainer.use()` call site is the one place they leaked.
 */
export const SERVICE_RENAMES: Record<string, string> = {
  AuthenticationServiceContainer: "AuthManager",
  EmailServiceContainer: "MailManager",
  LoggingServiceContainer: "LogManager",
  FileStorageServiceContainer: "FilesystemManager",
  QueueServiceContainer: "QueueManager",
  RedisServiceContainer: "RedisManager",
  BroadcastingServiceContainer: "BroadcastManager",
  ImageOptimizationServiceContainer: "ImageManager",
  ApiRouterServiceContainer: "ApiRouteDispatcher",
  ViewRouterServiceContainer: "ViewRouteDispatcher",
  I18nServiceContainer: "Translator",
  RateLimiterServiceContainer: "RateLimiter",
  CronServiceContainer: "Scheduler",
  MiddlewareServiceContainer: "MiddlewareRegistry",
  KernelIdServiceContainer: "KernelId",
};

/** Exports that are simply gone, with the sentence the TODO should carry. */
export const DELETED_EXPORTS: Record<string, string> = {
  Singleton:
    "`Singleton` was removed. Bind the class in a ServiceProvider instead — " +
    "`this.app.singleton(Thing, () => new Thing())` — and resolve it with " +
    "`app(Thing)` from `gemi/foundation`.",
  SingletonServiceContainer:
    "`SingletonServiceContainer` was removed. Use the container directly: " +
    "`app().singleton(Token, factory)`.",
  ServiceContainer:
    "`ServiceContainer` was removed. Services are plain classes now; bind them " +
    "in a ServiceProvider and resolve with `app(Token)`.",
  KernelIdServiceProvider:
    "`KernelIdServiceProvider` is internal to the framework now and has no " +
    "app-facing config slice.",
};

/** Exports that moved module without changing name. */
export const MODULE_MOVES: Record<string, { from: string[]; to: string }> = {
  ServiceProvider: { from: ["gemi/services", "gemi/kernel"], to: "gemi/support" },
};

/**
 * Where an inner class declared inside a provider file gets extracted to, keyed
 * by the base class it extends. Config files describe configuration; a class
 * that implements behaviour belongs in its own module.
 */
export const EXTRACTION_TARGETS: Record<string, string> = {
  HttpRequest: "app/http/requests",
  CronJob: "app/cron",
  Job: "app/jobs",
  BroadcastingChannel: "app/broadcasting",
  Middleware: "app/http/middleware",
  Email: "app/email",
  Policy: "app/policies",
};

export const TODO = "// TODO(gemi-migrate):";
