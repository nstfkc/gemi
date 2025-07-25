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
import type { UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";
import { useParams } from "./useParams";
import { ServerDataContext } from "./ServerDataProvider";
import { log } from "node:console";

// biome-ignore lint: type later
type Any = any;

interface MutationContextValue {
  isPending: boolean;
  result: null | Any;
  validationErrors: Record<string, string[]>;
  formError: null | string;
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

type Methods = {
  POST: PostRequests;
  PUT: PutRequests;
  DELETE: DeleteRequests;
  PATCH: PatchRequests;
};

interface FormProps<M extends keyof Methods, K extends keyof Methods[M]>
  extends Omit<ComponentProps<"form">, "action" | "onError"> {
  method?: M;
  action: K;
  onSuccess?: (result: Methods[M][K], form: HTMLFormElement) => void;
  onError?: (error: Any, form: HTMLFormElement) => void;
  params?: Partial<UrlParser<`${K & string}`>>;
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
    params,
    className,
    dynamicInputs = () => ({}),
    ...formProps
  } = "params" in props
    ? { ...props, params: { ..._params, ...props.params } }
    : { ...props, params: _params };
  const formRef = useRef<HTMLFormElement>(null);
  const { __csrf } = useContext(ServerDataContext);

  const { trigger, data, error, loading } = useMutation(
    method,
    String(action) as Any,
    {
      params,
    } as Any,
    {
      onSuccess: (data) => onSuccess(data as Any, formRef.current),
      onError: (error) => onError(error, formRef.current),
    },
  );

  const handleSubmit = async (e: FormEvent) => {
    if (loading) {
      return;
    }
    e.preventDefault();
    if (!formRef.current) {
      return;
    }
    const formData = new FormData(formRef.current);
    for (const [key, value] of Object.entries(dynamicInputs(formData))) {
      formData.append(key, value as any);
    }
    trigger(formData as any);
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
        <input type="hidden" name="__csrf" value={__csrf} />
        {props.children}
      </form>
    </MutationContext.Provider>
  );
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
