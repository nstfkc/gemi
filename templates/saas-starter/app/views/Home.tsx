import {
  Form,
  Link,
  useFormData,
  useLocation,
  useSearchParams,
  useTheme,
  useTranslator,
  type ViewProps,
} from "gemi/client";
import { useState } from "react";

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
  return (
    <div>
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
