import type { ServiceProviderConstructor } from "../foundation/Application";
import { AuthServiceProvider } from "../auth/AuthServiceProvider";
import { DatabaseServiceProvider } from "../database/DatabaseServiceProvider";
import { TranslationServiceProvider } from "../i18n/TranslationServiceProvider";
import { ScheduleServiceProvider } from "../services/cron/ScheduleServiceProvider";
import { MailServiceProvider } from "../services/email/MailServiceProvider";
import { FilesystemServiceProvider } from "../services/file-storage/FilesystemServiceProvider";
import { ImageServiceProvider } from "../services/image-optimization/ImageServiceProvider";
import { KernelIdServiceProvider } from "../services/kernel-id/KernelIdServiceProvider";
import { LogServiceProvider } from "../services/logging/LogServiceProvider";
import { MiddlewareServiceProvider } from "../services/middleware/MiddlewareServiceProvider";
import { BroadcastServiceProvider } from "../services/pubsub/BroadcastServiceProvider";
import { QueueServiceProvider } from "../services/queue/QueueServiceProvider";
import { RateLimiterServiceProvider } from "../services/rate-limiter/RateLimiterServiceProvider";
import { RedisServiceProvider } from "../services/redis/RedisServiceProvider";
import { RouteServiceProvider } from "../services/router/RouteServiceProvider";

/**
 * The providers every gemi app boots with, in registration order. Fifteen
 * providers for sixteen services — `RouteServiceProvider` owns both the api and
 * the view dispatcher, the way Laravel's does.
 *
 * Order only matters for `boot()`; `register()` binds factories and resolves
 * nothing, so no provider here depends on an earlier one having run.
 */
export const frameworkProviders: ServiceProviderConstructor[] = [
  KernelIdServiceProvider,
  MiddlewareServiceProvider,
  DatabaseServiceProvider,
  RouteServiceProvider,
  AuthServiceProvider,
  MailServiceProvider,
  LogServiceProvider,
  FilesystemServiceProvider,
  QueueServiceProvider,
  RedisServiceProvider,
  BroadcastServiceProvider,
  ImageServiceProvider,
  TranslationServiceProvider,
  RateLimiterServiceProvider,
  ScheduleServiceProvider,
];
