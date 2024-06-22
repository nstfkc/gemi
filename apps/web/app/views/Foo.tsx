import { Link } from "gemi/client";

export default function Foo() {
  return (
    <div>
      <h1>Foo</h1>
      <div>
        <Link href="/foo/bar">Bar</Link>
      </div>
    </div>
  );
}
