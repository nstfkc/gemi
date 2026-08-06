export { Model } from "./Model";
export { ActiveRecordModel } from "./active-record";

export {
  SCHEMA_ARTIFACT_VERSION,
  StaleSchemaArtifactError,
  assertSchemaArtifactVersion,
  type DefaultKind,
  type DefaultSpec,
  type FieldSchema,
  type ModelSchema,
  type RelationSchema,
  type ScalarType,
} from "./schema";

// The argument and result types the generated model bases are built from.
// Previously `@prisma/client`'s, which is what made an app install a 74MB
// package for types that are erased at build — and which described Prisma's
// query engine rather than gemi's compiler. See `types.ts`.
export type {
  AggregateArgs,
  AggregatePayload,
  CountArgs,
  CountPayload,
  CreateArgs,
  CreateInput,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FieldFilter,
  FindFirstArgs,
  FindFirstOrThrowArgs,
  FindManyArgs,
  FindUniqueArgs,
  FindUniqueOrThrowArgs,
  GroupByArgs,
  GroupByOrderByInput,
  GroupByPayload,
  IncludeInput,
  JsonInput,
  JsonValue,
  ModelTypeInfo,
  NullsOrder,
  OmitInput,
  OrderByInput,
  Payload,
  RelationInfo,
  Row,
  SelectInput,
  SelectSubset,
  SortOrder,
  SortOrderInput,
  Subset,
  UpdateArgs,
  UpdateInput,
  UpdateManyArgs,
  UpsertArgs,
  WhereInput,
  WhereUniqueInput,
} from "./types";

// Prisma's two `Json` null sentinels, under gemi's own names.
//
// A nullable `Json` column has two legal empty states and they are different
// rows, so the caller has to choose. `docs/orm.md` used to spell that choice
// `Prisma.DbNull` — a *runtime* value import of `@prisma/client` in ordinary
// application code, and the only one gemi's own documentation asked for.
// `json-null.ts` has always recognised the sentinels structurally rather than by
// identity, so these are accepted by exactly the same path Prisma's are, and an
// app that still passes Prisma's keeps working.
export {
  AnyNull,
  DbNull,
  JsonNull,
  jsonNullKind,
  type JsonNullKind,
} from "./json-null";

export {
  AmbiguousModelRegistrationError,
  DecodeError,
  MalformedRelationError,
  MissingModelSchemaError,
  MissingRequiredValueError,
  ModelNotRegisteredError,
  ParameterLimitError,
  PolicyDeniedError,
  RecordNotFoundError,
  RelationDepthExceededError,
  ReturningUnsupportedError,
  ScopeEscapeError,
  UniqueConstraintError,
  UnknownFieldError,
  UnknownRelationError,
  UnregisteredPolicyClassError,
  UnregisteredRelationTargetError,
  InvalidArgumentError,
  UnsupportedByDesignError,
  UnsupportedQueryError,
} from "./errors";

export {
  createCuid,
  clientSideValue,
  hasClientSideValue,
  isClientSideDefault,
} from "./defaults";

export {
  canonicalShape,
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
  type ExecOptions,
  type Operation,
  type QueryPlan,
} from "./plan";

// The ambient transaction. `Model.transaction` is the surface an application
// uses; these are for code that has to *observe* the scope rather than open one
// — a raw query joining it, or a test asserting a statement ran inside it.
export {
  currentActor,
  currentTransaction,
  isSystemScope,
  ormContext,
  runAsSystem,
  runAsUser,
  transactionDepth,
  withTransaction,
  type OrmScope,
} from "./context";

// The two failures a named connection can produce, re-exported from
// `gemi/database` because this is where they are *caught*: both come out of a
// model operation — `Subscription.on("analytics").findMany()` — and an
// application should not have to know that the manager rather than the ORM
// constructed them. `docs/orm.md`'s errors table is the list of what an
// application can catch, and it is checked against this module's exports.
export {
  CrossConnectionTransactionError,
  UnknownConnectionError,
} from "../database/Connection";

// Composable raw SQL. `DB.query` / `DB.execute` run what these build — the
// place every shape the ORM declines is supposed to land.
export {
  empty,
  join,
  renderFragment,
  sql,
  unsafeSql,
  type SqlFragment,
} from "./sql";

export {
  assertPoliciesRegistered,
  auditModelRegistrations,
  registerModels,
} from "./registration";

export {
  softDelete,
  softDeleteMany,
  softDeletes,
  type SoftDeleteOptions,
} from "./soft-deletes";

export {
  Policy,
  ScopedPolicy,
  applyPolicies,
  applyRedaction,
  currentUser,
  policiesFor,
  policyContext,
  redactNullable,
  type ModelPolicy,
  type PolicyContext,
  type PolicyEntry,
} from "./policy";

export {
  changedFields,
  isTracked,
  provenanceOf,
  resnapshot,
  track,
  type Provenance,
} from "./provenance";

export { compile, compileRead, compileWrite } from "./compile";
export {
  buildInterpretedShaper,
  buildRowShaper,
  setShaperCompilation,
  shaperCompilationAvailable,
  type RowShaper,
  type ShapedRelation,
} from "./shape";
export {
  createBindContext,
  type BindContext,
  type Binder,
} from "./compile/fragment";

// The relation planner is a swappable stage (invariant 4): iteration 3 ships
// the batched strategy, iteration 7 adds lateral + json_agg as a sibling.
export {
  MAX_RELATION_DEPTH,
  attachRelations,
  batchedStrategy,
  planRelations,
  strategiesOf,
  type RelationPlan,
  type RootContribution,
  type RelationPlanning,
  type RelationRequest,
  type RelationStrategy,
} from "./compile/plan-relations";

export { lateralStrategy } from "./compile/lateral";
export { defaultStrategy, resolveStrategy } from "./compile/strategy";

export {
  PostgresDialect,
  SqliteDialect,
  UnsupportedDialectError,
  dialectFor,
  everyDialect,
  ormSupports,
  type ConstraintViolation,
  type SqlDialect,
} from "./dialect";

// `get` / `has` are far too generic to sit in the flat namespace, so the
// registry is exported whole. `register` is flat because every generated
// `index.ts` calls it.
export * as registry from "./registry";
export { register } from "./registry";
