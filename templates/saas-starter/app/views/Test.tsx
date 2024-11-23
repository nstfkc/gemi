import {
  Form,
  useMutation,
  useParams,
  useQuery,
  useSubscription,
  type ViewProps,
} from "gemi/client";
import { useEffect, useState } from "react";

export default function Test(props: ViewProps<"/:testId">) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-green-900">Test</h1>
      <Form method="POST" action="/csrf">
        <button type="submit">Submit</button>
      </Form>
    </div>
  );
}
