import { Link } from "gemi/client";

export default function Bar() {
  return (
    <div>
      <h2 className="text-green-400">Bar</h2>
      <div>
        <Link href="/foo">Foo</Link>
      </div>
    </div>
  );
}
