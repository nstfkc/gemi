import {
  createContext,
  useContext,
  type ComponentProps,
  type FormEvent,
  useRef,
} from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { useMutation } from "./useMutation";
import type { IsEmptyObject, UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";

interface MutationContextValue {
  isPending: boolean;
  result: null | any;
  validationErrors: Record<string, string[]>;
  formError: null | string;
}

const MutationContext = createContext({
  isPending: false,
  result: null,
} as MutationContextValue);

type GetParams<T> =
  T extends ApiRouterHandler<any, any, infer Params> ? Params : {};

type GetResult<T> =
  T extends ApiRouterHandler<any, infer Result, any>
    ? UnwrapPromise<Result>
    : never;

type WithoutMethod<T extends string> = T extends `${string}:${infer Path}`
  ? Path
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

type Methods = {
  POST: PostRequests;
  PUT: PutRequests;
  DELETE: DeleteRequests;
  PATCH: PatchRequests;
};

interface FormBaseProps<M extends keyof Methods, K extends keyof Methods[M]>
  extends Omit<ComponentProps<"form">, "action"> {
  method: M;
  action: K;
  onSuccess?: (result: Methods[M][K]) => void;
  onError?: (error: any) => void;
}

type FormProps<
  T extends keyof Methods,
  K extends keyof Methods[T],
> = FormBaseProps<T, K> &
  (UrlParser<`${K & string}`> extends Record<string, never>
    ? { params?: never }
    : { params: UrlParser<`${K & string}`> });

export function Form<T extends keyof Methods, K extends keyof Methods[T]>(
  props: FormProps<T, K>,
) {
  const {
    method,
    action,
    onSuccess = () => {},
    onError = () => {},
    params,
    className,
    ...formProps
  } = "params" in props ? props : { ...props, params: {} };
  const formRef = useRef<HTMLFormElement>(null);

  const { trigger, data, error, loading } = useMutation(
    method,
    String(action) as any,
    {
      params,
    } as any,
    {
      onSuccess,
      onError,
    },
  );

  const handleSubmit = async (e: FormEvent) => {
    if (loading) {
      return;
    }
    e.preventDefault();
    trigger(new FormData(formRef.current!) as any);
  };

  const validationErrors =
    error?.kind === "validation_error" ? error.messages : {};

  const formError = error?.kind === "form_error" ? error.message : null;

  return (
    <MutationContext.Provider
      value={{ isPending: loading, result: data, validationErrors, formError }}
    >
      <form
        className={["group", className].filter(Boolean).join(" ")}
        data-loading={loading}
        ref={formRef}
        onSubmit={handleSubmit}
        {...formProps}
      >
        {props.children}
      </form>
    </MutationContext.Provider>
  );
}

export function useMutationStatus() {
  const { isPending } = useContext(MutationContext);

  return { isPending };
}

export const ValidationErrors = (props: {
  name: string;
  className?: string;
  render?: (props: ComponentProps<"div">) => JSX.Element;
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

export const FormField = (props: ComponentProps<"div"> & { name: string }) => {
  const { name, children, ...rest } = props;
  const { validationErrors } = useContext(MutationContext);
  const errors = validationErrors[name] || [];
  return (
    <div data-hasError={errors.length > 0} {...rest}>
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
