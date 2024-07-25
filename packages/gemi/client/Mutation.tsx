import {
  type PropsWithChildren,
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
  T extends ApiRouterHandler<any, any, infer Params> ? Params : never;

type GetResult<T> =
  T extends ApiRouterHandler<any, infer Result, any>
    ? UnwrapPromise<Result>
    : never;

type FormPropsWithParams<T extends keyof RPC> = {
  action: T extends `GET:${string}` ? never : T;
  params: GetParams<RPC[T]>;
  onSuccess?: (result: GetResult<RPC[T]>) => void;
  onError?: (error: any) => void;
};

type FormPropsWithoutParams<T extends keyof RPC> = {
  action: T extends `GET:${string}` ? never : T;
  onSuccess?: (result: GetResult<RPC[T]>) => void;
  onError?: (error: any) => void;
};

type FormProps<T extends keyof RPC> =
  GetParams<RPC[T]> extends Record<string, never>
    ? FormPropsWithoutParams<T>
    : FormPropsWithParams<T>;

export function Form<T extends keyof RPC>(
  props: PropsWithChildren<FormProps<T>>,
) {
  const { action } = props;
  const formRef = useRef<HTMLFormElement>(null);

  const params = "params" in props ? props.params : {};
  const { trigger, data, error, loading } = useMutation(action, {
    params,
  } as any);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    trigger(new FormData(formRef.current!));
  };

  const validationErrors =
    error?.kind === "validation_error" ? error.messages : {};

  const formError = error?.kind === "form_error" ? error.message : null;

  return (
    <MutationContext.Provider
      value={{ isPending: loading, result: data, validationErrors, formError }}
    >
      <form
        className="group"
        data-loading={loading}
        ref={formRef}
        onSubmit={handleSubmit}
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
