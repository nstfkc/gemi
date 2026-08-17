import type { ServiceProviderConstructor } from "../foundation/Application";
import { AuthServiceProvider } from "../auth/AuthServiceProvider";
import { DatabaseServiceProvider } from "../database/DatabaseServiceProvider";
import { TranslationServiceProvider } from "../i18n/TranslationServiceProvider";
import { ScheduleServiceProvider } from "../services/cron/ScheduleServiceProvider";
import { MailServiceProvider } from "../services/email/MailServiceProvider";
import { EventServiceProvider } from "../services/events/EventServiceProvider";
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
 * The providers every gemi app boots with, in registration order. Sixteen
 * providers for seventeen services — `RouteServiceProvider` owns both the api
 * and the view dispatcher, the way Laravel's does.
 *
 * Order only matters for `boot()`; `register()` binds factories and resolves
 * nothing, so no provider here depends on an earlier one having run — with one
 * exception, which is the reason to read this before reordering anything.
 *
 * **`EventServiceProvider` must stay after `QueueServiceProvider`.** A queued
 * listener is registered with the queue as a synthetic job, and
 * `EventServiceProvider.boot()` is what hands those over. `QueueManager.useJobs`
 * — which `QueueServiceProvider.boot()` calls with whatever it discovered under
 * `app/jobs` — *replaces* the registry (`this.jobs = {}`). Move the events
 * provider up and the two boots run in the order that discards: every
 * `listener:*` entry is registered and then thrown away. Nothing errors, boot
 * succeeds, and each queued dispatch afterwards lands on `next()`'s "Dropped a
 * queued job: nothing is registered under the name listener:SendWelcomeEmail",
 * long after `dispatch` returned to a caller that cannot hear it.
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
  EventServiceProvider,
  RedisServiceProvider,
  BroadcastServiceProvider,
  ImageServiceProvider,
  TranslationServiceProvider,
  RateLimiterServiceProvider,
  ScheduleServiceProvider,
];
