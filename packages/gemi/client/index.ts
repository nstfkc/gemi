/// <reference path="../gemi.d.ts" />
// The augmentation that gives an application its own route, view and dictionary
// types. Referenced from here — rather than left for the application to wire up
// — so that importing anything from `gemi/client` is all it takes. See
// `../gemi.d.ts`.

export { useQuery } from "./useQuery";
export type { QueryResult, GemiQueryDefaults } from "./useQuery";
export { useInfiniteQuery } from "./useInfiniteQuery";
export type {
  InfiniteQueryConfig,
  InfiniteQueryReturn,
} from "./useInfiniteQuery";
export { QueryError } from "./QueryError";
export { isRetryableQueryError } from "./retryPolicy";
export type {
  QueryFailure,
  RetryOption,
  RetryDelayOption,
} from "./retryPolicy";
export { useMutation, useDelete, usePatch, usePost, usePut, useUpload } from "./useMutation";
export type { MutationCallConfig, MutationConcurrency } from "./useMutation";
export { useMutate } from "./useMutate";
export {
  isValidationError,
  isFormError,
  isAuthenticationError,
  isPermissionError,
  isCsrfError,
  isNotFoundError,
  isRateLimitError,
  isServerError,
  isNetworkError,
  mutationErrorKind,
} from "./MutationError";
export type {
  MutationError,
  MutationErrorKind,
  MutationValidationError,
  MutationFormError,
  MutationServerError,
  MutationRefusal,
  MutationRefusalKind,
  MutationMessageError,
} from "./MutationError";
export type { RefusalKind } from "../http/refusal";
export {
  Form,
  FormError,
  useMutationStatus,
  useFormStatus,
  useFormData,
  FormFieldContainer,
  ValidationErrors,
} from "./Mutation";
export { QueryManagerProvider } from "./QueryManagerContext";
export type { QueryConfig, UserQueryConfig } from "./QueryManagerContext";
export { useParams } from "./useParams";
export { useDomain } from "./useDomain";
export { useLocation } from "./useLocation";
export { useSearchParams } from "./useSearchParams";
export { useRoute } from "./useRoute";
export { useIsNavigationPending } from "./useIsNavigationPending";
export { useNavigationProgress } from "./useNavigationProgress";
export { useNavigate } from "./useNavigate";
export { usePrefetch } from "./usePrefetch";
export { useBreadcrumbs } from "./useBreadcrumbs";
export { useRouteTransition } from "./RouteTransitionProvider";
export { Link } from "./Link";
export type { ExternalLinkProps, LinkProps, PrefetchStrategy } from "./Link";
export { Redirect } from "./Redirect";
export { init, create } from "./init";
export type { InitOptions } from "./init";
export {
  isChunkLoadError,
  recoverFromChunkLoadError,
  CHUNK_RELOAD_MARKER,
} from "./chunkLoadRecovery";
export type {
  ChunkLoadErrorContext,
  ChunkLoadErrorSource,
  ChunkLoadRecoveryOptions,
  ChunkReloadBlock,
} from "./chunkLoadRecovery";
export { createRoot } from "./createRoot";

export type {
  RPC,
  ViewRPC,
  I18nDictionary,
  Features,
  FeatureKey,
  ClientFeatureKey,
} from "./rpc";
export type { ViewProps, LayoutProps, ViewPaths } from "./types";
export type { CreateI18nDictionary } from "./I18nContext";

export { Image } from "./Image";
export { Head } from "./Head";

export { useForgotPassword } from "./auth/useForgotPassword";
export { useSignIn } from "./auth/useSignIn";
export { useSignUp } from "./auth/useSignUp";
export { useSignOut } from "./auth/useSignOut";
export { useResetPassword } from "./auth/useResetPassword";
export { useUser } from "./auth/useUser";
export { useIntendedUrl } from "./auth/useIntendedUrl";
export { useEmailCode } from "./auth/useEmailCode";

export { useFeature, useFeatures } from "./useFeature";
export { useTranslator } from "./useTranslator";
export { useDictionary } from "./useDictionary";
// Re-exported here as well as from `gemi/dictionary`: a dictionary lives next
// to the component that reads it, so both halves come from one import.
export { defineDictionary, type DictionaryHandle } from "../i18n/defineDictionary";
export { useLocale } from "./useLocale";

// Open Graph
export { OpenGraphImage } from "./OpenGraphImage";

export { useTheme } from "./ThemeProvider";
export { useAppIdMissmatch } from "./useAppIdMissmatch";
