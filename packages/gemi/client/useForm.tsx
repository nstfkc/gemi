import { type ComponentProps, type ReactNode } from "react";

export function useFormBuilder<T>(args: { fields: T }) {
  const Form = ({ children }: { children: ReactNode }) => {
    return <form>{children}</form>;
  };
  Form.Field = <K extends keyof T>({
    name,
    ...rest
  }: {
    name: K;
    // @ts-expect-error
  } & ComponentProps<(typeof args.fields)[K]>) => {
    const Component = args.fields[name];
    // @ts-expect-error
    return <Component name={name} {...rest} />;
  };

  return Form;
}

const Test = () => {
  const Form = useFormBuilder({
    //
    fields: {
      //
      name: (props: ComponentProps<"input">) => (
        <input {...props} type="text" />
      ),
      age: (props: ComponentProps<"input">) => <input {...props} type="text" />,
    },
  });

  return (
    <Form>
      <Form.Field name="name" />
    </Form>
  );
};
