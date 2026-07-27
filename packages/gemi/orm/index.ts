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
  MissingModelSchemaError,
  ModelNotRegisteredError,
  RecordNotFoundError,
  UnknownFieldError,
  UnsupportedQueryError,
} from "./errors";

export {
  canonicalShape,
  clearPlanCache,
  getOrCompile,
  planCacheStats,
  planKey,
  type Operation,
  type QueryPlan,
} from "./plan";

export { compile } from "./compile";
export { buildRowShaper, type RowShaper } from "./shape";

export {
  PostgresDialect,
  SqliteDialect,
  UnsupportedDialectError,
  dialectFor,
  type SqlDialect,
} from "./dialect";

// `get` / `has` are far too generic to sit in the flat namespace, so the
// registry is exported whole. `register` is flat because every generated
// `index.ts` calls it.
export * as registry from "./registry";
export { register } from "./registry";
