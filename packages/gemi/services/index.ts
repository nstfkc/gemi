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
  DeleteFileParams,
  DeletePrefixOptions,
  FetchFileOptions,
  FileMetadata,
  ListObjectsOptions,
  PutFileOptions,
  PutFileParams,
  PutStreamParams,
  ReadFileParams,
  ReadResult,
  StoredObject,
} from "./file-storage/drivers/types";
export {
  FileStorageDriver,
  assertDeletablePrefix,
} from "./file-storage/drivers/FileStorageDriver";
export {
  type PutFromUrlOptions,
  type PutFromUrlResult,
} from "./file-storage/putFromUrl";
export { sniffContentType } from "./file-storage/sniffContentType";
// The toolkit a custom driver needs to resolve a range against its backend.
export {
  resolveRange,
  toRangeHeaderValue,
  parseContentRange,
} from "../http/range";
export { FileNotFoundError, RangeNotSatisfiableError } from "../http/errors";

// Encryption: encrypted columns and the `Crypt` facade (#844)
export { EncryptionServiceProvider } from "./encryption/EncryptionServiceProvider";
export {
  DecryptionError,
  Encrypter,
  EncryptionKeyError,
} from "./encryption/Encrypter";
export {
  defineEncryptionConfig,
  type EncryptionConfig,
} from "./encryption/config";

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
export type {
  EmailAttachment,
  EmailDeliveryResult,
  EmailSendResult,
  SendEmailParams,
} from "./email/drivers/types";

// Router
export { RouteServiceProvider } from "./router/RouteServiceProvider";
export {
  ApiRouteDispatcher,
  type DispatchAsOptions,
  type DispatchCredentials,
} from "./router/ApiRouteDispatcher";
export { ViewRouteDispatcher } from "./router/ViewRouteDispatcher";
export { ISLAND_LOADER_CSP_HASH } from "./router/staticDocument";
// What `onStreamComplete` receives when a response body closes.
export type {
  StreamSummary,
  StreamQuerySummary,
} from "./router/ServerQueryStore";

// MCP: an app's exposed routes as tools, for an in-process agent and for
// remote MCP clients (#762). The `AgentTool` projection, `toAgentTools`, is
// exported from `gemi/ai`.
export {
  DEFAULT_MCP_SCOPE,
  McpCallRefusedError,
  McpRegistry,
  McpToolError,
  type McpCaller,
  type McpCallContext,
  type McpExecuteOptions,
  type McpRegistryOptions,
  type McpRemoteFileOptions,
  type McpRemotePrincipal,
  type McpScope,
  type McpCredentials,
  type McpToolAnnotations,
  type McpToolDescriptor,
  type McpToolFilter,
} from "./mcp/McpRegistry";
export {
  McpHttpServer,
  type McpRemoteHttpConfig,
} from "./mcp/http/McpHttpServer";
export {
  bearerToken,
  McpApiKeyResolver,
  type McpApiKey,
  type McpApiKeyResolverOptions,
  type McpCallerResolver,
  type McpResolution,
  type McpResolveContext,
} from "./mcp/http/callers";
export {
  McpOAuthServer,
  type McpConsent,
  type McpOAuthServerOptions,
} from "./mcp/http/oauth/McpOAuthServer";
export {
  MemoryMcpOAuthStore,
  type McpOAuthClient,
  type McpOAuthCode,
  type McpOAuthStore,
  type McpOAuthToken,
  type McpOAuthTokenEndpointAuthMethod,
} from "./mcp/http/oauth/store";
export { CONSENT_PAGE_HEADERS } from "./mcp/http/oauth/consentPage";

// Logging
export { LogServiceProvider } from "./logging/LogServiceProvider";
export { LogManager } from "./logging/LogManager";
export type { LogEntry } from "./logging/types";

// Queue
export { QueueServiceProvider } from "./queue/QueueServiceProvider";
export {
  QueueManager,
  type DrainResult,
  type DispatchedBatch,
  type JobBatchOptions,
} from "./queue/QueueManager";
export { MemoryQueueDriver } from "./queue/MemoryQueueDriver";
export {
  DatabaseQueueDriver,
  type DatabaseQueueDriverOptions,
  type DatabaseJobStatus,
} from "./queue/DatabaseQueueDriver";
export type {
  QueueDriver,
  EnqueueJob,
  ClaimOptions,
  ClaimedJob,
  JobFailure,
  JobRelease,
  EnqueueBatch,
} from "./queue/QueueDriver";
export type { BatchStatus, BatchCallbacks, JobCall } from "./queue/batch";
export {
  Job,
  type JobThrottle,
  type JobConcurrency,
  type JobBatch,
  type JobCallArgs,
} from "./queue/Job";

// Workflows: durable, resumable, built on the queue (#846).
export {
  Workflow,
  type WorkflowArgs,
  type WorkflowClass,
  type WorkflowStatus,
  type WorkflowStepStatus,
} from "./queue/workflow/Workflow";
export {
  Step,
  StepFailedError,
  StepTimeoutError,
  WaitTimeoutError,
  WorkflowCancelledError,
  type StepBatchOptions,
  type StepContext,
  type StepRunOptions,
  type StepWaitOptions,
} from "./queue/workflow/Step";
export type { Duration } from "./queue/workflow/duration";
export type {
  StepRecord,
  StepRunStatus,
  WorkflowRecord,
  WorkflowRunStatus,
  WorkflowStore,
} from "./queue/workflow/WorkflowStore";
export { WorkflowRuntime } from "./queue/workflow/WorkflowRuntime";
export { MemoryWorkflowStore } from "./queue/workflow/MemoryWorkflowStore";
export {
  DatabaseWorkflowStore,
  createWorkflowTableStatements,
} from "./queue/workflow/DatabaseWorkflowStore";

// Locks: the primitive under unique jobs and cron `withoutOverlapping`.
export {
  LockManager,
  HeldLock,
  type AcquireOptions,
  type LockRunResult,
} from "./lock/LockManager";
export { LockLostError, type LockStore } from "./lock/LockStore";

// Change feeds: publish "channel K changed", follow channels from a cursor.
export { ChangeFeedServiceProvider } from "./change-feed/ChangeFeedServiceProvider";
export {
  ChangeFeedManager,
  ChangeFeedSubscription,
  ChangeFeedFullError,
  type SubscribeOptions,
} from "./change-feed/ChangeFeedManager";
export type {
  ChangeFeedDriver,
  ChangeFeedEntry,
  ChangeFeedEvent,
  ChangeFeedRead,
} from "./change-feed/ChangeFeedDriver";
export {
  MemoryChangeFeedDriver,
  type MemoryChangeFeedDriverOptions,
} from "./change-feed/MemoryChangeFeedDriver";
export {
  DatabaseChangeFeedDriver,
  type DatabaseChangeFeedDriverOptions,
} from "./change-feed/DatabaseChangeFeedDriver";
export type {
  PostgresListener,
  PostgresListenerFactory,
} from "./change-feed/postgresListen";
export {
  decodeCursor,
  encodeCursor,
  type ChangeFeedCursor,
} from "./change-feed/cursor";
export type {
  ChangeFeedMessage,
  ChangeFeedResponse,
  StreamOptions as ChangeFeedStreamOptions,
} from "./change-feed/stream";
export { MemoryLockStore } from "./lock/MemoryLockStore";
export {
  DatabaseLockStore,
  type DatabaseLockStoreOptions,
} from "./lock/DatabaseLockStore";

// Events. `Event` shadows the DOM's global of the same name inside a module
// that imports it, which is what you want in server code and worth knowing in a
// file that also touches the browser one.
export { EventServiceProvider } from "./events/EventServiceProvider";
export { EventManager } from "./events/EventManager";
export { Event, type EventClass } from "./events/Event";
export { Listener, type ListenerClass } from "./events/Listener";

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
// For an application that writes session rows of its own — a migration, an
// import, a test fixture — rather than copying the crypto and the prefix (#621).
// Every `v2.` token is looked up, so one minted here is as good as a sign-in's.
export {
  SESSION_TOKEN_PREFIX,
  isSessionToken,
  mintSessionToken,
} from "../auth/sessionToken";
export { GoogleOAuthProvider } from "../auth/oauth/GoogleOAuthProvider";
export { XOAuthProvider } from "../auth/oauth/XOAuthProvider";
export { OAuthCallbackError, OAuthProvider } from "../auth/oauth/OAuthProvider";
export type {
  OAuthAuthorizationContext,
  OAuthCallbackContext,
  OAuthProfile,
} from "../auth/oauth/OAuthProvider";
// OAuth connections (#845): calling a provider's API on a user's behalf.
export { OAuthConnectionProvider } from "../auth/connections/OAuthConnectionProvider";
export type {
  OAuthConnectionProviderConfig,
  OAuthTokenSet,
} from "../auth/connections/OAuthConnectionProvider";
export { OAuthConnectionError, OAuthReconnectRequiredError } from "../auth/connections/errors";
export type { OAuthConnectionErrorCode } from "../auth/connections/errors";
export { ConnectionManager, ProviderConnection } from "../auth/connections/ConnectionManager";
export type { ConnectionOwner, FakeConnectionHandler } from "../auth/connections/ConnectionManager";
export { DatabaseConnectionStore, MemoryConnectionStore } from "../auth/connections/ConnectionStore";
export type { ConnectionRecord, ConnectionStore } from "../auth/connections/ConnectionStore";

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

// Discovery. What a `jobs`-less `queue` or `schedule` slice resolves to, what a
// `listeners`-less `events` slice resolves to, and the only way left to ask an
// application what it has: the config array a test used to import may not exist
// any more.
export {
  discoverJobs,
  discoverWorkflows,
  discoverCronJobs,
  discoverCommands,
  discoverListeners,
} from "./discovery";

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
  type ServerOnlyFeature,
} from "./features/defineFeature";
export { FeaturesServiceProvider } from "./features/FeaturesServiceProvider";
export {
  FeatureManager,
  FeatureScope,
  UndeclaredFeatureError,
  type FeatureActor,
  type FeatureSetOptions,
} from "./features/FeatureManager";
export {
  FeatureFlagStore,
  FeatureReloadError,
  type FlagAudit,
  type FlagSnapshot,
} from "./features/FeatureFlagStore";
export {
  FeatureFlagSource,
  FeatureModelMissingError,
  FeatureSourceReadOnlyError,
  type FeatureWriteMeta,
  type FeatureWriteResult,
} from "./features/sources/FeatureFlagSource";
export { DatabaseFeatureFlagSource } from "./features/sources/DatabaseFeatureFlagSource";
export { StaticFeatureFlagSource } from "./features/sources/StaticFeatureFlagSource";
export { evaluateFeature, subjectFor } from "./features/evaluate";
export { bucketKey, bucketOf, inRollout } from "./features/bucket";
export type { FeatureSubject } from "./features/context";
export type {
  EvaluationReason,
  FeatureContext,
  FeatureDescriptor,
  FeatureEvaluation,
  FeatureListing,
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
  defineRouteConfig,
  apiRouteConfigDefaults,
  viewRouteConfigDefaults,
  type RouteConfig,
  type ApiRouteConfig,
  type McpRouteConfig,
  type ViewRouteConfig,
  type LocaleRouting,
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
  defineChangeFeedConfig,
  changeFeedConfigDefaults,
  type ChangeFeedConfig,
} from "./change-feed/config";
export {
  defineEventConfig,
  eventConfigDefaults,
  type EventConfig,
} from "./events/config";
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
  type AuthenticatedArgs,
  type EmailCodeConfig,
  type EmailCodeSendArgs,
  type LegacySessionMigrator,
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
