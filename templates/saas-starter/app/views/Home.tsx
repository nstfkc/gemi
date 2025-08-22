import type { Account, Organization, User } from "@prisma/client";
import {
  Form,
  Link,
  useFormData,
  useLocation,
  useQuery,
  useSearchParams,
  useTheme,
  useTranslator,
  type QueryResult,
  type ViewProps,
} from "gemi/client";
import { useId, useState } from "react";

const FormData = () => {
  const formData = useFormData();
  const state = formData.getAll("test");
  console.log([
    { item: formData.get("number") },
    state,
    formData.get("text"),
    formData.get("radio"),
  ]);
  return <pre>{JSON.stringify({})}</pre>;
};

export default function Home() {
  const [value, setValue] = useState("");
  const [toggle, setToggle] = useState(false);
  const id = useId();
  return (
    <div data-testid="home" id={id}>
      {id}
      <h1>Home</h1>
      <button type="button" onClick={() => setValue("foo")}>
        Update
      </button>
      <button type="button" onClick={() => setToggle((s) => !s)}>
        Toggle
      </button>
      {toggle && (
        <div>
          <Form method="POST" action="/org/:orgId/products">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              name="test"
            />
            <input type="checkbox" name="test" />
            <input type="radio" name="radio" />
            <input name="number" type="number" />
            <div>
              <textarea name="text" />
            </div>
            <select name="option">
              <option value="1">Option 1</option>
              <option value="2">Option 2</option>
              <option value="3">Option 3</option>
            </select>
            <FormData />
          </Form>
        </div>
      )}
    </div>
  );
}

type data = {
  accounts: {
    organization: {
      name: string;
      id: number;
      publicId: string;
      logoUrl: string | null;
      description: string | null;
    } | null;
    id: number;
    publicId: string;
    organizationId: number | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    organizationRole: number;
    userId: number | null;
  }[];
  name: string | null;
  id: number;
  publicId: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  verificationToken: string | null;
  locale: string | null;
  globalRole: number;
  password: string | null;
  organizationId: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type user = {
  name: string | null;
  id: number;
  publicId: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  verificationToken: string | null;
  locale: string | null;
  globalRole: number;
  password: string | null;
  organizationId: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
} & {
  accounts: (Account & {
    organization: Organization;
  })[];
};

type Equals<U, T> = T extends U ? (U extends T ? true : false) : false;

type IsDataEqual = Equals<data, user>;
