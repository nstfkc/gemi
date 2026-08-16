// Filesystem
export { FilesystemServiceProvider } from "./file-storage/FilesystemServiceProvider";
export { FilesystemManager } from "./file-storage/FilesystemManager";
export { FileSystemDriver } from "./file-storage/drivers/FileSystemDriver";
export { S3Driver } from "./file-storage/drivers/S3Driver";
export {
  AzureBlobDriver,
  type AzureBlobDriverConfig,
} from "./file-storage/drivers/AzureBlobDriver";
export type {
  ByteRange,
  FileMetadata,
  PutFileParams,
  ReadFileParams,
  ReadResult,
} from "./file-storage/drivers/types";
export { FileStorageDriver } from "./file-storage/drivers/FileStorageDriver";
// The toolkit a custom driver needs to resolve a range against its backend.
export {
  resolveRange,
  toRangeHeaderValue,
  parseContentRange,
} from "../http/range";
export { FileNotFoundError, RangeNotSatisfiableError } from "../http/errors";

// Ratelimiter
export { RateLimiterServiceProvider } from "./rate-limiter/RateLimiterServiceProvider";
export { RateLimiter } from "./rate-limiter/RateLimiter";
export {
  InMemoryRateLimiter,
  type InMemoryRateLimiterOptions,
} from "./rate-limiter/drivers/InMemoryRateLimiterDriver";
export {
  RedisRateLimiter,
  type RedisRateLimiterOptions,
  type RateLimiterRedisClient,
} from "./rate-limiter/drivers/RedisRateLimiterDriver";
export { RateLimiterDriver } from "./rate-limiter/drivers/RateLimiterDriver";
export type { ConsumeParams, RateLimitResult } from "./rate-limiter/types";
export type { ConsumeOptions } from "./rate-limiter/RateLimiter";

// Email
export { MailServiceProvider } from "./email/MailServiceProvider";
export { MailManager } from "./email/MailManager";
export { EmailDriver } from "./email/drivers/EmailDriver";
export { ResendDriver } from "./email/drivers/ResendDriver";
export type { EmailAttachment, SendEmailParams } from "./email/drivers/types";

// Broadcasting
export { BroadcastServiceProvider } from "./pubsub/BroadcastServiceProvider";
export { BroadcastManager } from "./pubsub/BroadcastManager";

// Router
export { RouteServiceProvider } from "./router/RouteServiceProvider";
export { ApiRouteDispatcher } from "./router/ApiRouteDispatcher";
export { ViewRouteDispatcher } from "./router/ViewRouteDispatcher";
// What `onStreamComplete` receives when a response body closes.
export type {
  StreamSummary,
  StreamQuerySummary,
} from "./router/ServerQueryStore";

// Logging
export { LogServiceProvider } from "./logging/LogServiceProvider";
export { LogManager } from "./logging/LogManager";
export type { LogEntry } from "./logging/types";

// Queue
export { QueueServiceProvider } from "./queue/QueueServiceProvider";
export { QueueManager } from "./queue/QueueManager";
export { Job } from "./queue/Job";

// Image optimization
export { ImageServiceProvider } from "./image-optimization/ImageServiceProvider";
export { ImageManager } from "./image-optimization/ImageManager";
export type {
  FitEnum,
  ResizeParameters,
} from "./image-optimization/drivers/types";
export { ImageOptimizationDriver } from "./image-optimization/drivers/ImageOptimizationDriver";
export { Sharp } from "./image-optimization/drivers/SharpDriver";

// Auth
export { AuthServiceProvider } from "../auth/AuthServiceProvider";
// Exported for the same reason every other manager here is: an application that
// needs a different `UserProvider` rebinds this token in its own service
// provider, passing the subclass as the second constructor argument. That is
// the only supported way to install one — `AuthConfig` has no field for it —
// and `docs/authentication.md` documents it against this entrypoint.
export { AuthManager } from "../auth/AuthManager";
export { GoogleOAuthProvider } from "../auth/oauth/GoogleOAuthProvider";
export { XOAuthProvider } from "../auth/oauth/XOAuthProvider";
export { OAuthProvider } from "../auth/oauth/OAuthProvider";

// Middleware
export { MiddlewareServiceProvider } from "./middleware/MiddlewareServiceProvider";
export { MiddlewareRegistry } from "./middleware/MiddlewareRegistry";

// Kernel id
export { KernelIdServiceProvider } from "./kernel-id/KernelIdServiceProvider";
export { KernelId } from "./kernel-id/KernelId";

// Cron
export { ScheduleServiceProvider } from "./cron/ScheduleServiceProvider";
export { Scheduler } from "./cron/Scheduler";
export { CronJob } from "./cron/CronJob";

// Console commands. `defineCommand` is the authoring surface — the `Command`
// base class below is what it produces and what discovery finds, and
// subclassing it by hand gives up the typing that is the point (see
// `console/builder.ts`).
export { defineCommand } from "../console/builder";
export type { CommandBuilder } from "../console/builder";
export { Command, CommandFailed } from "../console/Command";
export type {
  ArgSpec,
  OptionSpec,
  CommandArgument,
  CommandOption,
  CommandClass,
  CommandResult,
} from "../console/Command";
export type { CommandContext } from "../console/context";
export { CommandRegistry } from "../console/CommandRegistry";

// Discovery. What a `jobs`-less `queue` or `schedule` slice resolves to, and
// the only way left to ask an application what it has: the config array a test
// used to import may not exist any more.
export { discoverJobs, discoverCronJobs, discoverCommands } from "./discovery";

// Redis
export { RedisServiceProvider } from "./redis/RedisServiceProvider";
export { RedisManager } from "./redis/RedisManager";

// Features
export {
  defineFeature,
  Feature,
  type CreateFeatures,
  type FeatureAttribution,
  type FeatureOptions,
  type FeatureRegistry,
} from "./features/defineFeature";
export { FeaturesServiceProvider } from "./features/FeaturesServiceProvider";
export { FeatureManager, FeatureScope } from "./features/FeatureManager";
export { FeatureFlagStore, type FlagSnapshot } from "./features/FeatureFlagStore";
export { FeatureFlagSource, FeatureModelMissingError } from "./features/sources/FeatureFlagSource";
export { DatabaseFeatureFlagSource } from "./features/sources/DatabaseFeatureFlagSource";
export { StaticFeatureFlagSource } from "./features/sources/StaticFeatureFlagSource";
export { evaluateFeature, subjectFor } from "./features/evaluate";
export { bucketKey, bucketOf, inRollout } from "./features/bucket";
export type { FeatureSubject } from "./features/context";
export type {
  EvaluationReason,
  FeatureContext,
  FeatureEvaluation,
} from "./features/types";

// Runtime config (`app/config/*.ts`)
export {
  defineFilesystemConfig,
  filesystemConfigDefaults,
  type FilesystemConfig,
} from "./file-storage/config";
export {
  defineRateLimiterConfig,
  rateLimiterConfigDefaults,
  type RateLimiterConfig,
} from "./rate-limiter/config";
export {
  defineMailConfig,
  mailConfigDefaults,
  type MailConfig,
} from "./email/config";
export {
  defineBroadcastConfig,
  broadcastConfigDefaults,
  type BroadcastConfig,
} from "./pubsub/config";
export {
  defineRouteConfig,
  apiRouteConfigDefaults,
  viewRouteConfigDefaults,
  type RouteConfig,
  type ApiRouteConfig,
  type ViewRouteConfig,
} from "./router/config";
export {
  defineLogConfig,
  logConfigDefaults,
  type LogConfig,
} from "./logging/config";
export {
  defineQueueConfig,
  queueConfigDefaults,
  type QueueConfig,
} from "./queue/config";
export {
  defineImageConfig,
  imageConfigDefaults,
  type ImageConfig,
} from "./image-optimization/config";
export {
  defineScheduleConfig,
  scheduleConfigDefaults,
  type ScheduleConfig,
} from "./cron/config";
export {
  defineCommandConfig,
  commandConfigDefaults,
  type CommandConfig,
} from "../console/config";
export {
  defineRedisConfig,
  redisConfigDefaults,
  type RedisConfig,
} from "./redis/config";
export {
  defineFeaturesConfig,
  featuresConfigDefaults,
  type FeaturesConfig,
} from "./features/config";
export {
  defineAuthConfig,
  authConfigDefaults,
  type AuthConfig,
} from "../auth/config";
export {
  defineTranslationConfig,
  translationConfigDefaults,
  type TranslationConfig,
} from "../i18n/config";
export {
  defineMiddlewareConfig,
  middlewareConfigDefaults,
  type MiddlewareConfig,
} from "../http/middleware-config";
