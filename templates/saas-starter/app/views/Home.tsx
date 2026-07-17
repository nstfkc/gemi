import { Form, FormError, ValidationErrors, useFormStatus } from "gemi/client";
import { useState } from "react";

function SubmitButton() {
  const { isPending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={isPending}
      className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {isPending ? "Submitting…" : "Submit"}
    </button>
  );
}

export default function Home() {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  return (
    <div className="mx-auto max-w-md space-y-6 p-8">
      <h1 className="text-2xl font-semibold">Home</h1>

      <Form
        action="/home"
        onSuccess={(res, form) => {
          setResult(res.data);
          form?.reset();
        }}
        className="space-y-4"
      >
        <FormError className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" />

        <div className="space-y-1">
          <label htmlFor="name" className="block text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
          <ValidationErrors name="name" className="text-sm text-red-600" />
        </div>

        <div className="space-y-1">
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
          <ValidationErrors name="email" className="text-sm text-red-600" />
        </div>

        <SubmitButton />
      </Form>

      {result && (
        <pre className="rounded-md bg-neutral-100 p-4 text-sm">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
