import { Link } from "gemi/client";

export default function Foo(props) {
  return (
    <div>
      <h1 className="font-bold text-xl">Foo</h1>
      <div>
        <Link href="/foo/bar">Bar</Link>
      </div>
      {props.children}
    </div>
  );
}
