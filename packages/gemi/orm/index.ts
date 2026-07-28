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

export {
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

export { assertPoliciesRegistered } from "./registration";

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
  ormSupports,
  type ConstraintViolation,
  type SqlDialect,
} from "./dialect";

// `get` / `has` are far too generic to sit in the flat namespace, so the
// registry is exported whole. `register` is flat because every generated
// `index.ts` calls it.
export * as registry from "./registry";
export { register } from "./registry";
