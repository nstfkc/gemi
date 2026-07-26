// FileStorage
export { FileStorageServiceProvider } from "./file-storage/FileStorageServiceProvider";
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
export type { ConsumeOptions } from "./rate-limiter/RateLimiterServiceContainer";

// Email
export { EmailServiceProvider } from "./email/EmailServiceProvider";
export { EmailDriver } from "./email/drivers/EmailDriver";
export { ResendDriver } from "./email/drivers/ResendDriver";
export type { EmailAttachment, SendEmailParams } from "./email/drivers/types";

// Broadcasting

export { BroadcastingServiceProvider } from "./pubsub/BroadcastingServiceProvider";

// Router
export { ViewRouterServiceProvider } from "./router/ViewRouterServiceProvider";
export { ApiRouterServiceProvider } from "./router/ApiRouterServiceProvider";

// Logging

export { LoggingServiceProvider } from "./logging/LoggingServiceProvider";
export type { LogEntry } from "./logging/types";

// Queue
export { QueueServiceProvider } from "./queue/QueueServiceProvider";
export { Job } from "./queue/Job";

// Image optimization
export { ImageOptimizationServiceProvider } from "./image-optimization/ImageOptimizationServiceProvider";
export type {
  FitEnum,
  ResizeParameters,
} from "./image-optimization/drivers/types";
export { ImageOptimizationDriver } from "./image-optimization/drivers/ImageOptimizationDriver";
export { Sharp } from "./image-optimization/drivers/SharpDriver";

// Auth
export { GoogleOAuthProvider } from "../auth/oauth/GoogleOAuthProvider";
export { XOAuthProvider } from "../auth/oauth/XOAuthProvider";
export { OAuthProvider } from "../auth/oauth/OAuthProvider";

// Cron
export { CronServiceProvider } from "./cron/CronServiceProvider";
export { CronJob } from "./cron/CronJob";

// Redis
export { RedisServiceProvider } from "./redis/RedisServiceProvider";

export { Singleton } from "./Singleton";
