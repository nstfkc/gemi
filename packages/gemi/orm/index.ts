export { Model } from "./Model";

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
  RecordNotFoundError,
  RelationDepthExceededError,
  ReturningUnsupportedError,
  UniqueConstraintError,
  UnknownFieldError,
  UnknownRelationError,
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
  type Operation,
  type QueryPlan,
} from "./plan";

// The ambient transaction. `Model.transaction` is the surface an application
// uses; these are for code that has to *observe* the scope rather than open one
// — a raw query joining it, or a test asserting a statement ran inside it.
export {
  currentTransaction,
  ormContext,
  transactionDepth,
  withTransaction,
  type TransactionScope,
} from "./context";

export { compile, compileRead, compileWrite } from "./compile";
export { buildRowShaper, type RowShaper, type ShapedRelation } from "./shape";
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
  type RelationPlan,
  type RelationPlanning,
  type RelationRequest,
  type RelationStrategy,
} from "./compile/plan-relations";

export {
  PostgresDialect,
  SqliteDialect,
  UnsupportedDialectError,
  dialectFor,
  type ConstraintViolation,
  type SqlDialect,
} from "./dialect";

// `get` / `has` are far too generic to sit in the flat namespace, so the
// registry is exported whole. `register` is flat because every generated
// `index.ts` calls it.
export * as registry from "./registry";
export { register } from "./registry";
