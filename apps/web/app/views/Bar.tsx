import { Link } from "gemi/client";

export default function Bar() {
  return (
    <div>
      <h1>Bar</h1>
      <div>
        <Link href="/foo">Foo</Link>
      </div>
    </div>
  );
}
