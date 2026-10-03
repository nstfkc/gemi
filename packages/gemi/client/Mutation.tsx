import {
  createContext,
  useContext,
  type ComponentProps,
  type Ref,
  useRef,
  useEffect,
  useSyncExternalStore,
  useCallback,
} from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { useMutation } from "./useMutation";
import type { UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";
import { useParams } from "./useParams";
import { ServerDataContext } from "./ServerDataProvider";
import { Subject } from "../utils/Subject";
import {
  isFormError,
  isValidationError,
  type MutationError,
} from "./MutationError";

type Any = any;

interface MutationContextValue {
  isPending: boolean;
  result: null | Any;
  validationErrors: Record<string, string[]>;
  formError: null | string;
  formDataSubject: React.RefObject<Subject<FormData>>;
}

const MutationContext = createContext({
  isPending: false,
  result: null,
} as MutationContextValue);

type GetResult<T> =
  T extends ApiRouterHandler<Any, infer Result, Any>
    ? UnwrapPromise<Result>
    : never;

type PostRequests = {
  [K in keyof RPC as K extends `POST:${infer P}` ? P : never]: GetResult<
    RPC[K]
  >;
};

type PutRequests = {
  [K in keyof RPC as K extends `PUT:${infer P}` ? P : never]: GetResult<RPC[K]>;
};

type DeleteRequests = {
  [K in keyof RPC as K extends `DELETE:${infer P}` ? P : never]: GetResult<
    RPC[K]
  >;
};

type PatchRequests = {
  [K in keyof RPC as K extends `PATCH:${infer P}` ? P : never]: GetResult<
    RPC[K]
  >;
};

type GetError<T> =
  T extends ApiRouterHandler<Any, Any, Any, infer E> ? E : never;

/** Each route's typed errors (`HttpResponse.error`), by method and path. */
type ErrorMethods = {
  [M in keyof Methods]: {
    [K in keyof RPC as K extends `${M}:${infer P}` ? P : never]: GetError<RPC[K]>;
  };
};

type Methods = {
  POST: PostRequests;
  PUT: PutRequests;
  DELETE: DeleteRequests;
  PATCH: PatchRequests;
};

// Whatever `<form onSubmit>` hands its handler under the installed
// `@types/react` — `SubmitEvent` in current versions, `FormEvent` in older
// ones — so the caller's handler can be called with it either way.
type FormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0];

interface FormProps<
  M extends keyof Methods,
  K extends keyof Methods[M],
> extends Omit<ComponentProps<"form">, "action" | "onError"> {
  method?: M;
  action: K;
  onSuccess?: (result: Methods[M][K], form: HTMLFormElement) => void;
  /**
   * Called when the request fails. `error` is a `MutationError`, or one of
   * the route's typed errors (the bodies its handler answers with
   * `HttpResponse.error` / `httpError`); narrow it with `isValidationError`,
   * `isPermissionError`, `isHttpError` and the other guards from
   * `gemi/client`. Validation and form errors are already rendered by
   * `<ValidationErrors>` and `<FormError>`.
   */
  // Method syntax, so a handler typed `(error: MutationError, form) => …`
  // still compiles for a route that has typed errors.
  onError?(
    error: MutationError | ErrorMethods[M][K & keyof ErrorMethods[M]],
    form: HTMLFormElement,
  ): void;
  /**
   * Called when a submit is about to send its request, with the exact
   * `FormData` that will be sent (after `dynamicInputs`). Return `false` to
   * skip the request. Not called for a submit swallowed because one is
   * already in flight.
   */
  onSubmitStart?: (
    formData: FormData,
    form: HTMLFormElement,
  ) => void | boolean;
  /** Called after `onSuccess` or `onError`, whichever ran. */
  onSettled?: (form: HTMLFormElement) => void;
  params?: Partial<UrlParser<`${K & string}`>>;
  search?: Record<string, string>;
  dynamicInputs?: (formData: FormData) => Record<string, any>;
}

export function Form<
  K extends keyof Methods[T],
  T extends keyof Methods = "POST",
>(props: FormProps<T, K>) {
  const _params = useParams();
  const {
    method = "POST",
    action,
    onSuccess = () => {},
    onError = () => {},
    onSubmitStart,
    onSettled,
    onSubmit,
    ref,
    params,
    search = {},
    className,
    dynamicInputs = () => ({}),
    ...formProps
  } = "params" in props
    ? { ...props, params: { ..._params, ...props.params } }
    : { ...props, params: _params };
  const formRef = useRef<HTMLFormElement>(null);
  // Both refs, not one or the other. A `ref` from the caller used to land in
  // the props spread over the `<form>`, which replaced `formRef` and left
  // every submit returning early at `!formRef.current`.
  const setFormRef = useCallback(
    (node: HTMLFormElement | null) => {
      formRef.current = node;
      const cleanup = assignRef(ref, node);
      // Returning a cleanup means React will not call this again with `null`,
      // so the detach happens here — including the caller's own cleanup when
      // their callback ref returned one.
      return () => {
        formRef.current = null;
        if (typeof cleanup === "function") {
          cleanup();
        } else {
          assignRef(ref, null);
        }
      };
    },
    [ref],
  );
  const { __csrf } = useContext(ServerDataContext);
  const formDataSubject = useRef(new Subject(new FormData()));

  const updateFormData = useCallback(() => {
    formDataSubject.current.next(new FormData(formRef.current));
  }, []);

  useEffect(() => {
    if (!formRef.current) return;

    formRef.current.addEventListener("input", updateFormData);

    const observer = new MutationObserver(() => {
      const formData = new FormData(formRef.current);
      formDataSubject.current.next(formData);
    });

    formRef.current.querySelectorAll("input").forEach((input) =>
      observer.observe(input, {
        attributes: true,
        attributeFilter: ["value"],
      }),
    );

    formRef.current.querySelectorAll("select").forEach((input) =>
      observer.observe(input, {
        attributes: true,
        attributeFilter: ["value"],
      }),
    );

    formRef.current.querySelectorAll("textarea").forEach((input) =>
      observer.observe(input, {
        attributes: true,
        attributeFilter: ["value"],
      }),
    );

    return () => {
      observer.disconnect();
      if (formRef.current) {
        formRef.current.removeEventListener("input", updateFormData);
      }
    };
  }, [updateFormData]);

  const { trigger, data, error, loading } = useMutation(
    method,
    String(action) as Any,
    {
      params,
      search,
    } as Any,
    {
      onSuccess: (data) => {
        onSuccess(data as Any, formRef.current);
        onSettled?.(formRef.current);
      },
      onError: (error) => {
        onError(error as Any, formRef.current);
        onSettled?.(formRef.current);
      },
    },
  );

  const handleSubmit = async (e: FormSubmitEvent) => {
    // Before the guards, not after: returning early without preventing the
    // default let the browser submit the form itself. A second click while a
    // slow submit was still in flight navigated the page away and took the
    // request with it.
    e.preventDefault();
    // The caller's `onSubmit` runs alongside this handler rather than instead
    // of it. It used to be spread over the `<form>` after `onSubmit=
    // {handleSubmit}` and win: no `preventDefault`, so the browser submitted
    // the form itself, and no request. It sees every submit event, like a
    // native handler does, and it cannot cancel the request — the default is
    // already prevented by now, so `defaultPrevented` carries no signal.
    // `onSubmitStart` returning `false` is the way to skip one.
    onSubmit?.(e);
    if (loading) {
      return;
    }
    if (!formRef.current) {
      return;
    }
    const formData = new FormData(formRef.current);
    for (const [key, value] of Object.entries(dynamicInputs(formData))) {
      formData.append(key, value as any);
    }
    if (onSubmitStart?.(formData, formRef.current) === false) {
      return;
    }
    trigger(formData as any);
  };

  const validationErrors = isValidationError(error) ? error.messages : {};

  const formError = isFormError(error) ? error.message : null;

  return (
    <MutationContext.Provider
      value={{
        isPending: loading,
        result: data,
        validationErrors,
        formError,
        formDataSubject,
      }}
    >
      {/* The spread comes first so that nothing in it can replace what
          `<Form>` needs to work; `ref` and `onSubmit` are composed above. */}
      <form
        {...formProps}
        className={["group", className].filter(Boolean).join(" ")}
        data-loading={loading}
        ref={setFormRef}
        onSubmit={handleSubmit}
      >
        <input type="hidden" name="__csrf" value={__csrf} />
        {props.children}
      </form>
    </MutationContext.Provider>
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    return ref(value);
  }
  if (ref) {
    ref.current = value;
  }
}

export function useMutationStatus() {
  const { isPending } = useContext(MutationContext);

  return { isPending };
}

export function useFormStatus() {
  const { isPending, validationErrors, formError } =
    useContext(MutationContext);

  return { isPending, validationErrors, formError };
}

export function useFormData() {
  const context = useContext(MutationContext);

  const { formDataSubject } = context;

  // Unbound on purpose: `Subject` binds in its constructor, so these are
  // stable across renders. The `.bind` calls that used to be here allocated a
  // fresh `subscribe` every render, which made `useSyncExternalStore` drop and
  // re-add this component's subscription on each pass.
  return useSyncExternalStore(
    formDataSubject.current.subscribe,
    formDataSubject.current.getValue,
    formDataSubject.current.getValue,
  );
}

export const ValidationErrors = (props: {
  name: string;
  className?: string;
  render?: (props: ComponentProps<"div">) => React.JSX.Element;
}) => {
  const {
    render = (props: ComponentProps<"div">) => <div {...props} />,
    name,
  } = props;
  const { validationErrors } = useContext(MutationContext);

  const Comp = render;

  if (validationErrors[name]?.length > 0) {
    return (
      <>
        {validationErrors[name].map((error) => {
          return (
            <Comp className={props.className} key={error}>
              {error}
            </Comp>
          );
        })}
      </>
    );
  }

  return null;
};

export const FormFieldContainer = (
  props: ComponentProps<"div"> & { name: string },
) => {
  const { name, children, ...rest } = props;
  const { validationErrors } = useContext(MutationContext);
  const errors = validationErrors[name] || [];
  return (
    <div data-has-error={errors.length > 0} {...rest}>
      {children}
    </div>
  );
};

export const FormError = (props: ComponentProps<"div">) => {
  const { formError } = useContext(MutationContext);

  if (formError) {
    return <div {...props}>{formError}</div>;
  }

  return null;
};
