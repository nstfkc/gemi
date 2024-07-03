import {
  type PropsWithChildren,
  createContext,
  useState,
  useContext,
  type ComponentProps,
  type FormEvent,
  useRef,
} from "react";

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

interface MutationProps {
  url: string;
  method?: "POST" | "GET" | "PUT" | "DELETE" | "PATCH";
  onSuccess?: (result: any) => void;
}

export const Mutation = (props: PropsWithChildren<MutationProps>) => {
  const { method = "POST" } = props;
  const [isPending, setIsPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState<null | string>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string[]>
  >({});

  const action = async (e: FormEvent) => {
    e.preventDefault();
    const formData = new FormData(formRef.current!);
    setIsPending(true);
    setResult(null);
    try {
      const res = await fetch(`/api${props.url}`, {
        method,
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        if ("error" in data) {
          if (data.error.kind === "validation_error") {
            setValidationErrors(data.error.messages);
          }
          if (data.error.kind === "form_error") {
            console.log(data.error.message);
            setFormError(data.error.message);
          }
        }
      } else {
        if (props.onSuccess) {
          props.onSuccess(data);
        }
        setResult(data);
      }
    } catch (err) {
      console.log(err);
    }

    setIsPending(false);
  };

  return (
    <MutationContext.Provider
      value={{ isPending, result, validationErrors, formError }}
    >
      <form ref={formRef} onSubmit={action}>
        {props.children}
      </form>
    </MutationContext.Provider>
  );
};

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

export const FormError = (props: ComponentProps<"div">) => {
  const { formError } = useContext(MutationContext);

  if (formError) {
    return <div {...props}>{formError}</div>;
  }

  return null;
};
