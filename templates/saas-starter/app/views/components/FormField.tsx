import { ValidationErrors } from "gemi/client";
import type { ReactNode } from "react";

interface FormFieldProps {
  children: ReactNode;
  name: string;
  label: string;
}

export const FormField = (props: FormFieldProps) => {
  const { name, label, children } = props;
  return (
    <div className="flex flex-col gap-2">
      <label
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        htmlFor={name}
      >
        {label}
      </label>
      {children}
      <ValidationErrors name={name} />
    </div>
  );
};
